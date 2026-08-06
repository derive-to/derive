import { publish } from "@derive/core"
import { z } from "zod"
import type { AppContext } from "../context"
import type { LoopTool } from "./agent-loop"
import { buildChatTools, type ChatPrincipal, type ChatToolSurface } from "./chat-tools"
import { ContextConflictError, createContextCore } from "./create-context"

/**
 * THE BUILDER'S OWN TWO TOOLS, riding alongside `find` + `read`.
 *
 * The interview (context-builder-prompt.ts) never writes directly: it calls `draft_manifest`
 * to show its work as a card, then `create_context_from_draft` once the person confirms. Two
 * tools rather than one because the confirmation step needs something to confirm — a single
 * "create" tool would have the model both compose the manifest and commit to it in the same
 * breath, with nothing shown to the person in between.
 *
 * The manifest text itself (`manifest_md`) is never rendered — the card is built from the
 * OTHER fields (name, description, knows, answers, wont), which is why `BuilderCard` omits it.
 * That is also the copy boundary: everything the person sees is plain language the model wrote
 * about what it built, never the manifest source.
 */
export interface ContextDraft {
  name: string
  description: string
  kind: "knowledge" | "worker"
  /** Plain-language scope bullets — what it knows. */
  knows: string[]
  /** How it answers. */
  answers: string
  /** Honest limits. */
  wont: string[]
  /** The full manifest the model wrote — internal; never shown to the person. */
  manifest_md: string
  source_short_ids: string[]
}

export interface BuilderCard {
  draft: Omit<ContextDraft, "manifest_md">
  created?: { context_id: string; name: string }
}

export interface BuilderToolSurface extends ChatToolSurface {
  /** The card produced by the LAST draft_manifest / create_context_from_draft call in this
   *  turn, for the reply writer to persist on meta.card. */
  card(): BuilderCard | null
}

// Same caps as the create route (routes/contexts.ts) on `name`, so a drafted context can never
// fail create() on a field the model controls. The other fields have no downstream validator —
// they only ever become card copy — so their caps here are generous ceilings against a runaway
// model, not correctness requirements.
const ContextDraftSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(280),
  kind: z.enum(["knowledge", "worker"]),
  knows: z.array(z.string().trim().min(1).max(200)).max(20),
  answers: z.string().trim().min(1).max(280),
  wont: z.array(z.string().trim().min(1).max(200)).max(20),
  manifest_md: z.string().min(1).max(200_000),
  source_short_ids: z.array(z.string().max(64)).max(50),
})

/** A zod schema's JSON Schema as a model is told about it — chat-tools.ts's `jsonSchemaOf`
 *  pattern, replicated here because it is not exported (and this module's schemas are already
 *  full `ZodObject`s, not the bare param-shape that helper's own signature expects). */
const toolParams = (schema: z.ZodType): Record<string, unknown> =>
  z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>

const cardFrom = (draft: ContextDraft, created?: BuilderCard["created"]): BuilderCard => {
  const { manifest_md: _manifest_md, ...rest } = draft
  return { draft: rest, ...(created ? { created } : {}) }
}

/** The header every builder-published manifest carries — the one place the internal word
 *  "manifest" is allowed to appear at all, and only inside the document's own source, never in
 *  anything spoken to the person. See global-constraints: conversation flow and card copy may
 *  never say "manifest", "short id", "runner token", or "serve". */
const manifestHeader = (name: string): string =>
  `<!-- This document is the instruction set for the "${name}" context in Derive.\n` +
  `     Agents read it to learn what the context knows and how it should answer.\n` +
  `     Edit it like any document; the context uses the newest version. -->\n\n`

/**
 * Build the two-tool builder surface for one guided-create turn, plus `find` + `read` for
 * looking at workspace documents the person mentions.
 *
 * `draft_manifest` and `create_context_from_draft` are NOT MCP tools — they exist only for this
 * turn's loop, so they are handled here directly rather than through `registerToolSurface`.
 * `find`/`read` still go through the real tool handlers via `buildChatTools`, for the same
 * reason every other chat lane reuses them (see chat-tools.ts): one set of authorization
 * checks, not a second one that could drift.
 */
export const buildContextBuilderTools = (
  ctx: AppContext,
  who: ChatPrincipal,
): BuilderToolSurface => {
  const rest = buildChatTools(ctx, who, new Set(["find", "read"]))

  let draft: ContextDraft | null = null
  let card: BuilderCard | null = null

  const tools: LoopTool[] = [
    {
      name: "draft_manifest",
      description:
        "Record the drafted context — what it knows, how it answers, its honest limits — as a card the person reviews. Call again with a revision if they ask for changes.",
      params: toolParams(ContextDraftSchema),
    },
    {
      name: "create_context_from_draft",
      description:
        "Create the context from the last drafted manifest, once the person has confirmed it. Requires draft_manifest to have been called first this turn.",
      params: toolParams(z.object({})),
    },
    ...rest.tools,
  ]

  const execute = async (name: string, input: unknown): Promise<unknown> => {
    if (name === "draft_manifest") {
      const parsed = ContextDraftSchema.safeParse(input)
      if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "invalid draft" }
      draft = parsed.data
      card = cardFrom(draft)
      return { ok: true, card }
    }
    if (name === "create_context_from_draft") {
      if (!draft) return { error: "call draft_manifest first" }
      const bytes = new TextEncoder().encode(manifestHeader(draft.name) + draft.manifest_md)
      // Deliberately NOT followed by afterPublish: that fan-out (unfurl, webhook, Slack
      // channel post) is for a document a person is publishing to be seen. A builder
      // manifest is an internal artifact born already wired to a context — the create
      // route's own path never runs it either, and a chat transcript is the wrong place
      // to explain why a brand-new "manifest.md" just appeared in notifications.
      const published = await publish(ctx.meta, ctx.blobs, {
        bytes,
        filename: "manifest.md",
        isBundle: false,
        orgId: who.org,
        title: `${draft.name} — context instructions`,
        authorId: who.user.id,
        source: "api",
      })
      try {
        const made = await createContextCore(ctx.meta, {
          orgId: who.org,
          userId: who.user.id,
          name: draft.name,
          manifestArtifactId: published.artifact.id,
        })
        // The dk_agt_ token is minted inside createContextCore and discarded right here —
        // a chat transcript is a bad place for a standing secret (same call this makes in
        // automate.ts's create_context action).
        const created = { context_id: made.context.id, name: made.context.name }
        card = cardFrom(draft, created)
        return { ok: true, context_id: made.context.id, card }
      } catch (err) {
        // A name collision is the one failure worth explaining: the mint already
        // succeeded and createContextCore unwound it, so this is a plain, actionable
        // result the model can relay ("that name is taken, try another") rather than a
        // thrown error that costs the turn. Anything else propagates raw.
        if (err instanceof ContextConflictError)
          return { error: "a context with that name already exists" }
        throw err
      }
    }
    return rest.execute(name, input)
  }

  return { tools, skills: rest.skills, execute, card: () => card }
}

import { publish, roleAllows, type SessionMessageRecord } from "@derive/core"
import { z } from "zod"
import type { AppContext } from "../context"
import type { LoopTool } from "./agent-loop"
import { cardForWire } from "./builder-card"
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

/** The card as it reaches a CLIENT: the human-facing draft and nothing else. */
export interface BuilderCard {
  draft: Omit<ContextDraft, "manifest_md">
  created?: { context_id: string; name: string }
}

/**
 * The card as the TRANSCRIPT stores it — the same card plus the two things the NEXT turn
 * needs and no client ever sees.
 *
 * THE PROBLEM THIS SOLVES. The natural rhythm of the conversation is "here is what I would
 * build" (turn one) then "yes, do it" (turn two), and a tool surface built per turn holds the
 * draft in a closure that dies with turn one. The model would have to write the manifest again
 * from memory to create anything, so the document behind the created context could differ from
 * the card the person actually approved — a confirmation step that confirms nothing.
 *
 * So the draft is persisted where this lane already persists everything: the agent message's
 * meta. `manifest_md` rides along (the whole point — it is what must not be regenerated) and
 * is stripped at every wire read (`cardForWire`), so the client contract is unchanged.
 *
 * `published_artifact_id` is the same idea for the OTHER half-finished state: the manifest
 * document is published before the context row is inserted, so a create that fails after the
 * publish has already produced a real document. Remembering it means a retry wires THAT one up
 * instead of publishing a second copy of the same text.
 */
export interface StoredBuilderCard extends BuilderCard {
  draft: ContextDraft
  published_artifact_id?: string
}

export interface BuilderToolSurface extends ChatToolSurface {
  /** The card produced by the LAST draft_manifest / create_context_from_draft call in this
   *  turn, for the reply writer to persist on meta.card. The STORED shape — the reply writer
   *  is writing the transcript, and the transcript is what the next turn reads back. */
  card(): StoredBuilderCard | null
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

/**
 * The newest draft this conversation has produced, read back off its own transcript.
 *
 * Newest-first over AGENT messages only: an asker cannot write meta, and the last card written
 * is by construction the last one the person was shown — which is the one they are confirming.
 * A row without `manifest_md` is a card that predates this (or one already stripped), and
 * seeding from it would let a create run on a draft with no document to publish, so it does not
 * count as a draft at all.
 */
export const latestBuilderCard = (
  transcript: readonly SessionMessageRecord[],
): StoredBuilderCard | null => {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i]
    if (!m || m.author_kind !== "agent" || !m.meta) continue
    try {
      const card = (JSON.parse(m.meta) as { card?: StoredBuilderCard }).card
      if (card?.draft && typeof card.draft.manifest_md === "string" && card.draft.manifest_md)
        return card
    } catch {
      /* a hand-edited row must not break the next turn */
    }
  }
  return null
}

const cardFrom = (
  draft: ContextDraft,
  publishedArtifactId: string | null,
  created?: BuilderCard["created"],
): StoredBuilderCard => ({
  draft,
  ...(publishedArtifactId ? { published_artifact_id: publishedArtifactId } : {}),
  ...(created ? { created } : {}),
})

/** The header every builder-published manifest carries — the one place the internal word
 *  "manifest" is allowed to appear at all, and only inside the document's own source, never in
 *  anything spoken to the person. See global-constraints: conversation flow and card copy may
 *  never say "manifest", "short id", "runner token", or "serve". */
const manifestHeader = (name: string): string =>
  `<!-- This document is the instruction set for the "${name}" context in Derive.\n` +
  `     Agents read it to learn what the context knows and how it should answer.\n` +
  `     Edit it like any document; the context uses the newest version. -->\n\n`

/**
 * WHY CREATING IS GATED HERE and not only by the tools underneath.
 *
 * `find` and `read` come from `buildChatTools`, so their authorization lives inside the real
 * MCP handlers and holds without this file knowing anything. These two do not: `draft_manifest`
 * and `create_context_from_draft` are local to the turn, and `create_context_from_draft`
 * performs three privileged writes in a row (publish a document, insert a context row, mint a
 * managed agent). Nothing beneath it would refuse a Viewer, because nothing beneath it is a
 * tool with a gate — so the gate is here, matched to the REST create route's (`publish`, see
 * routes/contexts.ts's `requireWorkspace(c, "publish")`).
 *
 * Refusals are RETURNED, never thrown: a returned `{ error }` is text the model can relay to
 * the person, while a throw costs the turn and tells them nothing (chat-tools.ts states the
 * same rule for its own executor). And they are checked BEFORE the publish, so a refused
 * create leaves no document behind.
 */
const CANNOT_CREATE =
  "They do not have permission to create things in this workspace, so this cannot be created for them. An Admin can change their access under Settings › Members. Tell them that plainly and do not try again."

/** The killswitch demotes every hosted agent write to a proposal (see autonomy.ts). A context
 *  cannot BE a proposal — there is no reviewable draft of "a new packaged helper" — so the
 *  honest reading of the switch here is a refusal, not a quiet live create while every gated
 *  lane has stopped. Same discipline as chat-tools.ts's `chatPolicy`, which routes an ordinary
 *  chat publish to review under the same flag. */
const PAUSED =
  "An admin has paused agent changes in this workspace, so nothing can be created right now. Tell them nothing is lost — everything they told you is still here — and that it can be created once that is switched back on."

/**
 * Build the two-tool builder surface for one guided-create turn, plus `find` + `read` for
 * looking at workspace documents the person mentions.
 *
 * `draft_manifest` and `create_context_from_draft` are NOT MCP tools — they exist only for this
 * turn's loop, so they are handled here directly rather than through `registerToolSurface`.
 * `find`/`read` still go through the real tool handlers via `buildChatTools`, for the same
 * reason every other chat lane reuses them (see chat-tools.ts): one set of authorization
 * checks, not a second one that could drift.
 *
 * `seed` is the newest card off the transcript (`latestBuilderCard`), which is what lets a
 * person confirm on the turn AFTER the one that drafted — the ordinary flow — without the model
 * writing the manifest a second time.
 */
export const buildContextBuilderTools = (
  ctx: AppContext,
  who: ChatPrincipal,
  seed?: StoredBuilderCard | null,
): BuilderToolSurface => {
  const rest = buildChatTools(ctx, who, new Set(["find", "read"]))

  let draft: ContextDraft | null = seed?.draft ?? null
  // The document already published for THAT draft, if a previous turn got that far.
  let publishedArtifactId: string | null = seed?.published_artifact_id ?? null
  // Nothing has happened on THIS turn yet: a turn that neither drafts nor creates writes no
  // card, so the seed keeps standing as the newest one rather than being rewritten unchanged.
  let card: StoredBuilderCard | null = null

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
        "Create the context from the last drafted manifest, once the person has confirmed it. The draft carries across turns, so a confirmation in a later message needs no re-draft — only call draft_manifest again to CHANGE something.",
      params: toolParams(z.object({})),
    },
    ...rest.tools,
  ]

  const execute = async (name: string, input: unknown): Promise<unknown> => {
    if (name === "draft_manifest") {
      const parsed = ContextDraftSchema.safeParse(input)
      if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "invalid draft" }
      draft = parsed.data
      // A REVISION IS A DIFFERENT DOCUMENT. Whatever was published for the previous draft is
      // not this text, so it must not be wired up as if it were — the reuse below is strictly
      // for retrying the SAME approved draft.
      publishedArtifactId = null
      card = cardFrom(draft, null)
      return { ok: true, card: cardForWire(card) }
    }
    if (name === "create_context_from_draft") {
      if (!roleAllows(who.seatRole, "publish")) return { error: CANNOT_CREATE }
      if (who.flags?.agentKillswitch) return { error: PAUSED }
      if (!draft) return { error: "call draft_manifest first" }
      // REUSE the document a previous attempt already published for this same draft, rather
      // than publishing a second copy of identical text under a second name.
      if (!publishedArtifactId) {
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
        publishedArtifactId = published.artifact.id
      }
      // Recorded BEFORE the create is attempted, so the pointer survives even a failure that
      // costs the turn: the reply writer persists whatever card stands when the turn ends, and
      // the next turn seeds from it.
      card = cardFrom(draft, publishedArtifactId)
      try {
        const made = await createContextCore(ctx.meta, {
          orgId: who.org,
          userId: who.user.id,
          name: draft.name,
          manifestArtifactId: publishedArtifactId,
        })
        // The dk_agt_ token is minted inside createContextCore and discarded right here —
        // a chat transcript is a bad place for a standing secret (same call this makes in
        // automate.ts's create_context action).
        const created = { context_id: made.context.id, name: made.context.name }
        card = cardFrom(draft, publishedArtifactId, created)
        return { ok: true, context_id: made.context.id, card: cardForWire(card) }
      } catch (err) {
        // A name collision is the one failure worth explaining: the mint already
        // succeeded and createContextCore unwound it, so this is a plain, actionable
        // result the model can relay ("that name is taken, try another") rather than a
        // thrown error that costs the turn. Anything else propagates raw.
        if (err instanceof ContextConflictError)
          return {
            error: "a context with that name already exists",
            note: "Nothing was lost — everything they told you is still here, and the write-up is already saved. A different name finishes it without starting over.",
          }
        throw err
      }
    }
    return rest.execute(name, input)
  }

  return { tools, skills: rest.skills, execute, card: () => card }
}

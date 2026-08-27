import { publish, roleAllows, type SessionMessageRecord } from "@derive/core"
import { z } from "zod"
import type { AppContext } from "../context"
import type { LoopTool } from "./agent-loop"
import {
  buildChatTools,
  type ChatPrincipal,
  type ChatToolSurface,
  jsonSchemaOf,
} from "./chat-tools"
import {
  type BuilderCard,
  type ContextDraft,
  ContextDraftSchema,
  cardForWire,
  type StoredBuilderCard,
  storedCardFromMeta,
} from "./context-builder-card"
import { ContextConflictError, createContextCore } from "./create-context"

export type { BuilderCard, ContextDraft, StoredBuilderCard } from "./context-builder-card"

export interface BuilderToolSurface extends ChatToolSurface {
  /** The last builder state produced this turn, persisted for the next turn. */
  card(): StoredBuilderCard | null
}

const DRAFT_TOOL: LoopTool = {
  name: "draft_manifest",
  description:
    "Record the drafted Agent as a card for the person to review. Call again when they request a revision.",
  params: jsonSchemaOf(ContextDraftSchema),
}

const CREATE_TOOL: LoopTool = {
  name: "create_context_from_draft",
  description:
    "Create the Agent from the last confirmed draft. Drafts carry across turns; only draft again to change one.",
  params: jsonSchemaOf(z.object({})),
}

const CANNOT_CREATE =
  "They do not have permission to create things in this workspace, so this cannot be created for them. An Admin can change their access under Settings › Members. Tell them that plainly and do not try again."
const PAUSED =
  "An admin has paused agent changes in this workspace, so nothing can be created right now. Tell them nothing is lost — everything they told you is still here — and that it can be created once that is switched back on."

const manifestDocument = (draft: ContextDraft): Uint8Array =>
  new TextEncoder().encode(
    `<!-- This document is the instruction set for the "${draft.name}" Agent in Derive.\n` +
      "     It reads this to learn what it knows and how it should answer.\n" +
      "     Edit it like any document; the Agent uses the newest version. -->\n\n" +
      draft.manifest_md,
  )

const storedCard = (
  draft: ContextDraft,
  publishedArtifactId: string | null,
  created?: BuilderCard["created"],
): StoredBuilderCard => ({
  draft,
  ...(publishedArtifactId ? { published_artifact_id: publishedArtifactId } : {}),
  ...(created ? { created } : {}),
})

/** Find the newest complete builder draft in a transcript. */
export const latestBuilderCard = (
  transcript: readonly SessionMessageRecord[],
): StoredBuilderCard | null => {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const message = transcript[i]
    if (message?.author_kind !== "agent") continue
    const card = storedCardFromMeta(message.meta)
    if (card) return card
  }
  return null
}

/** Build the builder-only draft/create tools alongside the standard read-only chat tools. */
export const buildContextBuilderTools = (
  ctx: AppContext,
  who: ChatPrincipal,
  seed?: StoredBuilderCard | null,
): BuilderToolSurface => {
  const base = buildChatTools(ctx, who, new Set(["find", "read"]))
  let draft = seed?.draft ?? null
  let publishedArtifactId = seed?.published_artifact_id ?? null
  let currentCard: StoredBuilderCard | null = null

  const draftContext = (input: unknown): unknown => {
    const parsed = ContextDraftSchema.safeParse(input)
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "invalid draft" }
    draft = parsed.data
    publishedArtifactId = null
    currentCard = storedCard(draft, null)
    return { ok: true, card: cardForWire(currentCard) }
  }

  const createContext = async (): Promise<unknown> => {
    if (!roleAllows(who.seatRole, "publish")) return { error: CANNOT_CREATE }
    if (who.flags?.agentWrites === false) return { error: PAUSED }
    if (!draft) return { error: "call draft_manifest first" }

    if (!publishedArtifactId) {
      const published = await publish(ctx.meta, ctx.blobs, {
        bytes: manifestDocument(draft),
        filename: "manifest.md",
        isBundle: false,
        orgId: who.org,
        title: `${draft.name} — context instructions`,
        authorId: who.user.id,
        source: "api",
      })
      publishedArtifactId = published.artifact.id
    }

    // Persist the published artifact pointer even if context creation fails, so a retry reuses it.
    currentCard = storedCard(draft, publishedArtifactId)
    try {
      const made = await createContextCore(ctx.meta, {
        orgId: who.org,
        userId: who.user.id,
        name: draft.name,
        manifestArtifactId: publishedArtifactId,
      })
      const created = { context_id: made.context.id, name: made.context.name }
      currentCard = storedCard(draft, publishedArtifactId, created)
      return { ok: true, context_id: made.context.id, card: cardForWire(currentCard) }
    } catch (error) {
      if (!(error instanceof ContextConflictError)) throw error
      return {
        error: "a context with that name already exists",
        note: "Nothing was lost — everything they told you is still here, and the write-up is already saved. A different name finishes it without starting over.",
      }
    }
  }

  return {
    tools: [DRAFT_TOOL, CREATE_TOOL, ...base.tools],
    skills: base.skills,
    execute: (name, input) => {
      if (name === DRAFT_TOOL.name) return Promise.resolve(draftContext(input))
      if (name === CREATE_TOOL.name) return createContext()
      return base.execute(name, input)
    },
    card: () => currentCard,
  }
}

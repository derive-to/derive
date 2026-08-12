import { z } from "zod"

const shortText = z.string().trim().min(1).max(200)

export const PublicContextDraftSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(280),
  kind: z.enum(["knowledge", "worker"]),
  knows: z.array(shortText).max(20),
  answers: z.string().trim().min(1).max(280),
  wont: z.array(shortText).max(20),
  source_short_ids: z.array(z.string().max(64)).max(50),
})

export const ContextDraftSchema = PublicContextDraftSchema.extend({
  manifest_md: z.string().min(1).max(200_000),
})

const CreatedContextSchema = z.object({ context_id: z.string(), name: z.string() })

export const BuilderCardSchema = z.object({
  draft: PublicContextDraftSchema,
  created: CreatedContextSchema.optional(),
})

export const StoredBuilderCardSchema = BuilderCardSchema.extend({
  draft: ContextDraftSchema,
  published_artifact_id: z.string().optional(),
})

export type ContextDraft = z.infer<typeof ContextDraftSchema>
export type BuilderCard = z.infer<typeof BuilderCardSchema>
export type StoredBuilderCard = z.infer<typeof StoredBuilderCardSchema>

const jsonObject = (raw: string | null): Record<string, unknown> | null => {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Return only the schema-approved public card fields. Unknown stored fields are dropped. */
export const cardForWire = (card: unknown): BuilderCard | null =>
  BuilderCardSchema.safeParse(card).data ?? null

/** Read the latest usable draft state from one stored message payload. */
export const storedCardFromMeta = (raw: string | null): StoredBuilderCard | null => {
  const meta = jsonObject(raw)
  return StoredBuilderCardSchema.safeParse(meta?.card).data ?? null
}

/** Parse message metadata and replace any stored builder card with its public projection. */
export const metaForWire = (raw: string | null): Record<string, unknown> | null => {
  const meta = jsonObject(raw)
  if (!meta) return meta
  // Product navigation metadata belongs in the agent's system context, not in
  // the transcript payload or the UI. The person sees the template name in the
  // natural-language request; its internal URI never leaks as chat chrome.
  const { template_start: _templateStart, ...visible } = meta
  if (Object.keys(visible).length === 0) return null
  if (!("card" in visible)) return visible
  const { card, ...rest } = visible
  const publicCard = cardForWire(card)
  return publicCard ? { ...rest, card: publicCard } : rest
}

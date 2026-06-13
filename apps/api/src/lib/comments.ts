import type { CommentRecord } from "@dock/core"

/** The fixed reaction set; arbitrary emoji are rejected to keep data clean. */
export const REACTIONS = ["👍", "❤️", "🎉", "😄", "👀", "🙏", "🚀", "👎"]

/** A resolved @mention captured by the composer: the picked user's id + display name. */
export type Mention = { id: string; name: string }

export type CommentMeta = {
  reactions?: Record<string, string[]>
  edited_at?: string
  deleted?: boolean
  mentions?: Mention[]
}

export const parseMeta = (m: string | null): CommentMeta => {
  if (!m) return {}
  try {
    return JSON.parse(m) as CommentMeta
  } catch {
    return {}
  }
}

/** Coerce arbitrary input into a clean Mention[] (defensive against bad clients). */
export function parseMentions(input: unknown): Mention[] {
  if (!Array.isArray(input)) return []
  const out: Mention[] = []
  const seen = new Set<string>()
  for (const m of input) {
    if (!m || typeof m !== "object") continue
    const id = (m as { id?: unknown }).id
    const name = (m as { name?: unknown }).name
    if (typeof id !== "string" || typeof name !== "string" || !id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name })
  }
  return out
}

/** Wire shape for a comment: meta unpacked into clean fields; deleted bodies blanked. */
export function commentJson(cm: CommentRecord, anchored?: boolean) {
  const { meta, ...rest } = cm
  const md = parseMeta(meta)
  const deleted = !!md.deleted
  return {
    ...rest,
    body_md: deleted ? "" : cm.body_md,
    reactions: md.reactions ?? {},
    edited: !!md.edited_at,
    edited_at: md.edited_at ?? null,
    deleted,
    mentions: deleted ? [] : (md.mentions ?? []),
    ...(anchored !== undefined ? { anchored } : {}),
  }
}

/** A short single-line preview of a comment body for notification rows. */
export const previewOf = (body: string): string => {
  const flat = body.replace(/\s+/g, " ").trim()
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat
}

/** The quoted text from a comment anchor, for webhook payloads. */
export const quoteOf = (anchor: string | null): string | null => {
  if (!anchor) return null
  try {
    return (JSON.parse(anchor) as { exact?: string }).exact ?? null
  } catch {
    return null
  }
}

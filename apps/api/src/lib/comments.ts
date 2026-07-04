import type { ArtifactRecord, CommentRecord, MetaStore } from "@derive/core"

/** A deep link to a comment thread on an artifact — channel-neutral, shared by the email,
 *  Slack, and GitHub notification builders. Normalizes a trailing slash on baseUrl. */
export const commentDeepLink = (
  baseUrl: string,
  artifact: ArtifactRecord,
  threadId: string,
): string =>
  `${baseUrl.replace(/\/$/, "")}/artifacts/${artifact.short_id}?comment=${encodeURIComponent(threadId)}`

/** Is `actorId` a trusted author for OUTBOUND external posting (Slack / GitHub PR)?
 *  Those channels post as Derive's own bot/app into the customer's systems, so we only
 *  mirror comments authored by a real collaborator — a workspace member, an explicit
 *  artifact-share recipient, or a registered agent. An anonymous commenter or a logged-in
 *  non-member on a public artifact is NOT trusted to write into the owner's GitHub/Slack.
 *  (In-app notifications + email to collaborators are gated separately and stay in-Derive.) */
export const isCollaboratorAuthor = async (
  meta: MetaStore,
  artifact: ArtifactRecord,
  actorId: string | null,
): Promise<boolean> => {
  if (!actorId) return false
  if (await meta.getMembership(artifact.org_id, actorId)) return true
  if (await meta.getArtifactMember(artifact.id, actorId)) return true
  return (await meta.listAgents(artifact.org_id)).some((a) => a.id === actorId)
}

/** The fixed reaction set; arbitrary emoji are rejected to keep data clean. */
export const REACTIONS = ["👍", "❤️", "🎉", "😄", "👀", "🙏", "🚀", "👎"]

/** A resolved @mention captured by the composer: the picked user's id + display name. */
export type Mention = { id: string; name: string }

/** Upper bound on distinct @mentions per comment. A real comment mentions a
 *  handful of collaborators; the cap stops one comment from fanning out to a huge
 *  list (notifications are gated to members/shares, but this bounds the work +
 *  the blast radius regardless). */
export const MAX_MENTIONS = 50

export type CommentMeta = {
  reactions?: Record<string, string[]>
  edited_at?: string
  deleted?: boolean
  mentions?: Mention[]
  // The id of the open proposal whose revision claims to address this thread.
  // Set when the thread flips to `addressed`; cleared when that proposal is
  // approved (→ resolved) or withdrawn / sent back for changes (→ open).
  addressed_by?: string
  // Provenance for cross-channel sync. Set when a comment ORIGINATED in GitHub
  // (mirrored in) or, once Derive has posted a comment OUT to GitHub, the id GitHub
  // assigned it. Either presence means "don't re-post this comment to GitHub" —
  // the loop-prevention marker for bidirectional PR comment sync.
  github?: { comment_id: number; kind: "issue" | "review" }
  // Likewise for the connected Slack App: a comment that came FROM a Slack thread
  // reply (so it isn't echoed back), or the Slack message ts a Derive comment produced.
  slack?: { ts: string; channel: string }
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
    if (out.length >= MAX_MENTIONS) break
  }
  return out
}

/** Wire shape for a comment: meta unpacked into clean fields; deleted bodies blanked.
 *  `owner_id` is dropped — the server already filters personal comments to their
 *  owner, so the client never needs it; `visibility` ships for tab routing. */
export function commentJson(cm: CommentRecord, anchored?: boolean) {
  const { meta, owner_id: _owner, ...rest } = cm
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

/** A short referent for a comment anchor, for webhook payloads — the quoted text
 *  for a text anchor, or the element's snapshot label for an element anchor. */
export const quoteOf = (anchor: string | null): string | null => {
  if (!anchor) return null
  try {
    const a = JSON.parse(anchor) as { exact?: string; type?: string; snapshot?: { label?: string } }
    if (a.type === "ElementSelector") return a.snapshot?.label ?? null
    return a.exact ?? null
  } catch {
    return null
  }
}

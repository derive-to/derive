// @mentions in an artifact's LIVE document source. Comments persist their picked mention ids;
// source is intentionally portable Markdown/HTML, so the server resolves newly introduced
// @handles at publish time instead. This keeps web, MCP, API, restore, and agent edits on the
// same behavior without baking app-private ids into a document.

import {
  type ArtifactRecord,
  type BlobStore,
  isHtmlLike,
  type MetaStore,
  mentionText,
  mentionTokens,
  newId,
  normalizeUsername,
  type VersionRecord,
} from "@derive/core"
import type { Backplane } from "../bus"
import { log } from "../log"
import { enqueueChannelDelivery } from "../webhooks"
import { buildArtifactMentionEmail } from "./email"
import { eligibleMentionRecipientIds } from "./mention-access"
import { enqueueSlackArtifactMentionDms } from "./slack-dm"
import { truncate } from "./text"

const MAX_CONTENT_MENTIONS = 50

export type ContentMentionTarget = {
  id: string
  name: string
  handle: string
  /** Per-recipient text surrounding this handle, derived after the target passes the access gate. */
  excerpt?: string
}

/** Markdown code is source, not live document prose. Keep it out of notification parsing so a
 * README example like `const owner = "@alex"` cannot page a real teammate. */
const markdownProse = (source: string): string => {
  const lines: string[] = []
  let fence: { char: "`" | "~"; size: number } | null = null
  for (const line of source.split("\n")) {
    const run = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (run) {
      const char = run[0] as "`" | "~"
      if (!fence) {
        fence = { char, size: run.length }
        continue
      }
      if (char === fence.char && run.length >= fence.size) {
        fence = null
        continue
      }
    }
    if (!fence) lines.push(line)
  }
  const markdown = lines
    .join("\n")
    // Inline code does not render as document prose either.
    .replace(/`[^`\r\n]*`/g, " ")
    // Preserve the rendered labels of Markdown links while dropping their URL targets.
    .replace(/!?\[([^\]]*)\]\([^\s)]+(?:\s+[^)]*)?\)/g, "$1")
    .replace(/<!--[\s\S]*?-->/g, " ")
  // Markdown accepts inline HTML. Run the same non-prose projection over that
  // residual markup so `<code>@alex</code>` behaves like backtick code.
  return mentionText(markdown)
}

/** What a reader can see, reduced to text for mention matching and notification excerpts. A URL
 * can visibly contain `/@handle`; it names a route, not a teammate, so remove URL tokens before
 * the mention matcher sees them. */
export const contentMentionText = (source: string, contentType: string): string =>
  (isHtmlLike(contentType) ? mentionText(source) : markdownProse(source))
    .replace(/\b(?:https?:\/\/|mailto:|www\.)[^\s<]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()

/** Extract at most fifty normalized handles from visible body prose, in document order. */
export const contentMentionHandles = (source: string, contentType: string): string[] => {
  const text = contentMentionText(source, contentType)
  const out: string[] = []
  const seen = new Set<string>()
  for (const token of mentionTokens(text)) {
    const handle = normalizeUsername(token.handle)
    if (seen.has(handle)) continue
    seen.add(handle)
    out.push(handle)
    if (out.length >= MAX_CONTENT_MENTIONS) break
  }
  return out
}

/** A bounded, human-readable window centered on a particular body mention. */
export const contentMentionExcerpt = (
  source: string,
  contentType: string,
  handle: string,
): string => {
  const text = contentMentionText(source, contentType)
  const at = text.toLowerCase().indexOf(`@${normalizeUsername(handle)}`)
  if (at < 0) return truncate(text, 320)
  const start = Math.max(0, at - 130)
  const end = Math.min(text.length, at + handle.length + 170)
  const prefix = start > 0 ? "…" : ""
  const suffix = end < text.length ? "…" : ""
  return `${prefix}${text.slice(start, end).trim()}${suffix}`
}

/** Resolve source handles only to people who can already see this artifact. The document text is
 * untrusted input, so public visibility alone never permits someone to push a notification to a
 * stranger. A workspace seat counts only when this particular artifact admits the workspace;
 * an invite-only document requires its own or a collection share. */
export const resolveContentMentionTargets = async (
  meta: MetaStore,
  artifact: ArtifactRecord,
  handles: string[],
  actorId: string | null,
): Promise<ContentMentionTarget[]> => {
  if (!handles.length) return []
  const profiles = await Promise.all(
    handles.map(async (handle) => ({ handle, profile: await meta.getUserByUsername(handle) })),
  )
  const eligible = await eligibleMentionRecipientIds(
    meta,
    artifact,
    profiles.flatMap(({ profile }) => (profile ? [profile.id] : [])),
  )
  const targets: ContentMentionTarget[] = []
  for (const { handle, profile } of profiles) {
    if (!profile || profile.id === actorId || !eligible.has(profile.id)) continue
    targets.push({
      id: profile.id,
      name: profile.name ?? profile.username ?? handle,
      handle,
    })
  }
  return targets
}

/** Durable in-app bell rows for document-body mentions. Empty thread/comment ids deliberately
 * route the client to the artifact itself rather than inventing a comment thread. */
export const notifyContentMentions = async (
  deps: { meta: MetaStore; bus: Backplane },
  artifact: ArtifactRecord,
  targets: ContentMentionTarget[],
  input: { author: string; excerpt: string },
): Promise<void> => {
  if (!targets.length) return
  const rows = targets.map((target) => ({
    id: newId("n"),
    user_id: target.id,
    actor: input.author,
    kind: "mention" as const,
    artifact_id: artifact.id,
    artifact_short_id: artifact.short_id,
    artifact_title: artifact.title,
    thread_id: "",
    comment_id: "",
    preview: target.excerpt ?? input.excerpt,
  }))
  await deps.meta.createNotifications(rows)
  for (const row of rows)
    deps.bus.publish(`u:${row.user_id}`, {
      type: "notification",
      notification: { ...row, read: 0, created_at: new Date().toISOString() },
    })
}

/** Body mentions are open-and-read notifications, not reply surfaces: only a canonical comment
 * thread can safely mirror a future email or Slack reply back into Derive. */
export const enqueueContentMentionEmails = async (
  deps: { meta: MetaStore; baseUrl: string },
  artifact: ArtifactRecord,
  targets: ContentMentionTarget[],
  input: { author: string; excerpt: string },
): Promise<void> => {
  const users = await deps.meta.getUsers(targets.map((target) => target.id))
  const byId = new Map(targets.map((target) => [target.id, target]))
  await Promise.all(
    users
      .filter((user) => user.email)
      .map((user) => {
        const target = byId.get(user.id)
        return enqueueChannelDelivery(deps.meta, "email", "artifact.mention", {
          to: user.email,
          toName: user.name ?? undefined,
          ...buildArtifactMentionEmail(deps.baseUrl, artifact, {
            ...input,
            excerpt: target?.excerpt ?? input.excerpt,
          }),
        })
      }),
  )
}

export interface ContentMentionFanoutDeps {
  meta: MetaStore
  blobs: BlobStore
  bus: Backplane
  /** Optional so direct store-only callers remain safe; normal app publishes always bind it. */
  baseUrl?: string
}

/** Detect handles newly introduced by this version and fan them out independently. The entire
 * routine is deliberately post-publish best effort: a blob/notification/email outage is logged
 * and never changes the version that is already live. */
export const fanOutNewContentMentions = async (
  deps: ContentMentionFanoutDeps,
  artifact: ArtifactRecord,
  version: VersionRecord,
  actorId: string | null = version.author_id,
  preparedSource?: string,
): Promise<void> => {
  if (version.content_type !== "text/markdown" && !isHtmlLike(version.content_type)) return
  let current = preparedSource
  if (current === undefined) {
    const bytes = await deps.blobs.get(version.blob_key)
    if (!bytes) return
    current = new TextDecoder().decode(bytes)
  }
  const handles = contentMentionHandles(current, version.content_type)
  if (!handles.length) return

  let previousHandles = new Set<string>()
  if (version.n > 1) {
    const previous = await deps.meta.getVersion(artifact.id, version.n - 1)
    if (!previous) return // Cannot safely tell whether an existing mention is new.
    const previousBytes = await deps.blobs.get(previous.blob_key)
    if (!previousBytes) return
    previousHandles = new Set(
      contentMentionHandles(new TextDecoder().decode(previousBytes), previous.content_type),
    )
  }
  const added = handles.filter((handle) => !previousHandles.has(handle))
  if (!added.length) return

  // `version.author_id` is attribution (an agent often publishes on a person's behalf), while
  // `actorId` is the principal who actually made this edit. Suppress only a true self-mention so
  // an agent can deliberately hand a live document question back to its human.
  const targets = await resolveContentMentionTargets(deps.meta, artifact, added, actorId)
  if (!targets.length) return
  // Each recipient gets the local prose around THEIR handle rather than a generic document
  // prefix or another person's mention. It is derived only after the collaborator gate above.
  const resolved = targets.map((target) => ({
    ...target,
    excerpt: contentMentionExcerpt(current, version.content_type, target.handle),
  }))
  const excerpt = resolved[0]?.excerpt ?? ""
  const safely = async (surface: string, work: () => Promise<void>) => {
    try {
      await work()
    } catch (err) {
      log.warn("content mention fan-out failed", {
        artifact: artifact.id,
        version: version.n,
        surface,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  await safely("in-app", () =>
    notifyContentMentions({ meta: deps.meta, bus: deps.bus }, artifact, resolved, {
      author: version.author,
      excerpt,
    }),
  )
  if (!deps.baseUrl) return
  const settings = await deps.meta.getOrgSettings(artifact.org_id).catch((err) => {
    log.warn("content mention fan-out failed", {
      artifact: artifact.id,
      version: version.n,
      surface: "settings",
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  })
  if (settings?.emailNotifications)
    await safely("email", () =>
      enqueueContentMentionEmails(
        { meta: deps.meta, baseUrl: deps.baseUrl as string },
        artifact,
        resolved,
        {
          author: version.author,
          excerpt,
        },
      ),
    )
  await safely("slack:mention-dm", () =>
    enqueueSlackArtifactMentionDms(
      { meta: deps.meta, baseUrl: deps.baseUrl as string },
      artifact,
      resolved,
      { author: version.author, excerpt },
    ),
  )
}

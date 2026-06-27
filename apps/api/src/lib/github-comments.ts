// Dock → GitHub comment write-back. When someone comments on a PR-sourced artifact,
// mirror it onto the pull request: an inline review comment on the anchored file+line
// when we can resolve one, else a top-level PR conversation comment. Rides the same
// retrying outbox as everything else (kind="github_review_comment" / "github_issue_comment").
//
// Loop prevention: a comment that originated in GitHub carries `meta.github`; we never
// re-post those. After a successful post we stamp `meta.github` with the id GitHub
// returned, both so the inbound webhook can dedupe and so an edit/resync won't double-post.

import type { DeliveryRecord } from "@dock/core"
import {
  type ArtifactRecord,
  type BlobStore,
  type CommentRecord,
  type MetaStore,
  newId,
  type RepoSourceRecord,
} from "@dock/core"
import { type ChannelSendResult, enqueueChannelDelivery } from "../webhooks"
import { parseMeta, quoteOf } from "./comments"
import { decryptSecret } from "./crypto"
import { parseRepo, type RepoRef } from "./github"
import { installationToken } from "./github-app"

const API = "https://api.github.com"
const UA = "dock-comments/1"
const API_VERSION = "2022-11-28"

const headers = (token: string): Record<string, string> => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  "user-agent": UA,
  "x-github-api-version": API_VERSION,
  "content-type": "application/json",
})

/** A GitHub write failure carrying the HTTP status, so the delivery sender can tell a
 *  permanent 4xx (don't retry) from a transient 429/5xx (retry). */
export class GitHubWriteError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

/** A 4xx (except 429 rate-limit) is permanent — retrying can't succeed. */
export const isPermanentStatus = (status: number): boolean =>
  status >= 400 && status < 500 && status !== 429

/** Post a top-level PR conversation comment. Returns the new comment's GitHub id. */
export async function createIssueComment(
  repo: RepoRef,
  prNumber: number,
  body: string,
  token: string,
): Promise<number> {
  const url = `${API}/repos/${repo.owner}/${repo.name}/issues/${prNumber}/comments`
  const res = await fetch(url, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ body }),
  })
  if (!res.ok)
    throw new GitHubWriteError(
      res.status,
      `issue comment HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
    )
  return ((await res.json()) as { id: number }).id
}

// An invisible (HTML-comment) marker on the single Dock-managed "preview" comment, so we
// edit it in place on each sync instead of spamming the PR thread with a new one.
const PREVIEW_MARK = "<!-- dock-preview -->"

interface IssueComment {
  id: number
  body?: string
}

/** A PR's conversation (issue) comments, first ~3 pages — enough to find our own near
 *  the top. */
async function listIssueComments(
  repo: RepoRef,
  prNumber: number,
  token: string,
): Promise<IssueComment[]> {
  const out: IssueComment[] = []
  for (let page = 1; page <= 3; page++) {
    const url = `${API}/repos/${repo.owner}/${repo.name}/issues/${prNumber}/comments?per_page=100&page=${page}`
    const res = await fetch(url, { headers: headers(token) })
    if (!res.ok) throw new GitHubWriteError(res.status, `list issue comments HTTP ${res.status}`)
    const batch = (await res.json()) as IssueComment[]
    out.push(...batch)
    if (batch.length < 100) break
  }
  return out
}

/** Edit an existing issue comment's body. */
async function updateIssueComment(
  repo: RepoRef,
  commentId: number,
  body: string,
  token: string,
): Promise<void> {
  const url = `${API}/repos/${repo.owner}/${repo.name}/issues/comments/${commentId}`
  const res = await fetch(url, {
    method: "PATCH",
    headers: headers(token),
    body: JSON.stringify({ body }),
  })
  if (!res.ok)
    throw new GitHubWriteError(
      res.status,
      `update issue comment HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
    )
}

/** The id of the Dock-managed preview comment among a PR's comments (by our marker), or
 *  null when we haven't posted one yet. Pure — exported for testing. */
export const findPreviewComment = (comments: IssueComment[]): number | null =>
  comments.find((c) => c.body?.includes(PREVIEW_MARK))?.id ?? null

/** Post or update the single Dock-managed "preview" comment on a PR. The marker makes it
 *  sticky (subsequent syncs edit the same comment). The `MARK` footer keeps the inbound
 *  mirror from ingesting it back as a Dock comment. Caller swallows errors — a failed
 *  comment never blocks the preview sync. */
export async function upsertPreviewComment(
  repo: RepoRef,
  prNumber: number,
  body: string,
  token: string,
): Promise<void> {
  const full = `${body}\n\n<sub>${MARK} · kept in sync with the PR</sub>\n${PREVIEW_MARK}`
  const existingId = findPreviewComment(await listIssueComments(repo, prNumber, token))
  if (existingId != null) await updateIssueComment(repo, existingId, full, token)
  else await createIssueComment(repo, prNumber, full, token)
}

/** Post an inline PR review comment on a file+line of the head commit. Throws on 422
 *  (the line isn't part of the PR diff) so the caller can fall back to an issue comment. */
export async function createReviewComment(
  repo: RepoRef,
  prNumber: number,
  args: { commitId: string; path: string; line: number; body: string },
  token: string,
): Promise<number> {
  const url = `${API}/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/comments`
  const res = await fetch(url, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      body: args.body,
      commit_id: args.commitId,
      path: args.path,
      line: args.line,
      side: "RIGHT",
    }),
  })
  if (!res.ok)
    throw new GitHubWriteError(
      res.status,
      `review comment HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
    )
  return ((await res.json()) as { id: number }).id
}

/** The 1-based line number where `quote`'s first line first appears in `text`, or null.
 *  Anchors can span multiple lines; GitHub wants a single line, so we match the quote's
 *  first non-empty line (trimmed) — robust to leading indentation differences. */
export const lineOfQuote = (text: string, quote: string): number | null => {
  const needle = quote
    .split("\n")
    .find((l) => l.trim() !== "")
    ?.trim()
  if (!needle) return null
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) if (lines[i]?.includes(needle)) return i + 1
  return null
}

/** Find the PR-preview repo source whose `files` map contains this artifact, and the
 *  repo path it maps to. Null when the artifact isn't part of any open PR preview. */
export const prSourceForArtifact = async (
  meta: MetaStore,
  artifact: ArtifactRecord,
): Promise<{ source: RepoSourceRecord; path: string } | null> => {
  const sources = await meta.listRepoSources(artifact.org_id)
  for (const s of sources) {
    if (s.pr_number == null) continue
    let files: Record<string, { artifact_id: string }>
    try {
      files = JSON.parse(s.files) as Record<string, { artifact_id: string }>
    } catch {
      continue
    }
    const path = Object.keys(files).find((p) => files[p]?.artifact_id === artifact.id)
    if (path) return { source: s, path }
  }
  return null
}

/** The payload an enqueued GitHub-comment delivery carries (self-contained). */
interface GithubCommentPayload {
  repo: string
  prNumber: number
  installationId: string | null
  body: string
  dockCommentId: string
  // Inline-review fields; absent ⇒ post a top-level issue comment.
  path?: string
  line?: number
  commitId?: string
}

const MARK = "via Dock"

/** Render the comment body posted to GitHub: the Dock author + body + a deep link back,
 *  tagged so the inbound webhook can recognise our own posts as a backstop to `meta`. */
const ghBody = (baseUrl: string, artifact: ArtifactRecord, cm: CommentRecord): string => {
  const link = `${baseUrl.replace(/\/$/, "")}/a/${artifact.short_id}?c=${encodeURIComponent(cm.thread_id)}`
  return `**${cm.author}** commented in [Dock](${link}):\n\n${cm.body_md}\n\n_— ${MARK}_`
}

/** Decide how a Dock comment maps onto the PR and enqueue the delivery. No-op when the
 *  artifact isn't PR-sourced or the comment came from GitHub (loop prevention). Reads
 *  the artifact's current blob to resolve the anchored line for an inline comment. */
export const enqueueGithubPrComment = async (
  deps: { meta: MetaStore; blobs: BlobStore; baseUrl: string },
  artifact: ArtifactRecord,
  cm: CommentRecord,
): Promise<void> => {
  const { meta, blobs, baseUrl } = deps
  if (parseMeta(cm.meta).github) return // came from GitHub — don't echo back
  const found = await prSourceForArtifact(meta, artifact)
  if (!found) return
  const { source, path } = found

  const payload: GithubCommentPayload = {
    repo: source.repo,
    prNumber: source.pr_number as number,
    installationId: source.installation_id,
    body: ghBody(baseUrl, artifact, cm),
    dockCommentId: cm.id,
  }

  // Try to anchor to a file line: resolve the quoted text against the synced head blob.
  const quote = quoteOf(cm.anchor)
  if (quote && source.ref) {
    const version = await meta.getVersion(artifact.id, artifact.current_version)
    const bytes = version ? await blobs.get(version.blob_key) : null
    const line = bytes ? lineOfQuote(new TextDecoder().decode(bytes), quote) : null
    if (line) {
      payload.path = path
      payload.line = line
      payload.commitId = source.ref // a PR source's `ref` IS the head commit sha
    }
  }

  const kind = payload.line ? "github_review_comment" : "github_issue_comment"
  await enqueueChannelDelivery(meta, kind, "comment.created", payload)
}

// ---- GitHub → Dock (mirror PR comments into the artifact) ------------------

/** The commented line's source text, extracted from a review comment's `diff_hunk`
 *  (its last content line, with the leading +/-/space diff marker stripped). Used to
 *  build a Dock text anchor so the mirrored comment lands on the right quote. Null when
 *  the hunk has no usable line. */
export const lineFromDiffHunk = (diffHunk: string | undefined): string | null => {
  if (!diffHunk) return null
  const lines = diffHunk.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    if (!l || l.startsWith("@@") || l.startsWith("-")) continue
    const text = l.replace(/^[+ ]/, "").trim()
    if (text) return text
  }
  return null
}

/** Author marker for a comment mirrored in from GitHub (so it's clearly not a Dock user). */
const ghAuthorId = (login: string): string => `gh:${login}`

export interface IngestArgs {
  ghCommentId: number
  kind: "issue" | "review"
  authorLogin: string
  authorType?: string
  body: string
  /** Inline review comments: the repo file path + diff hunk to anchor against. */
  path?: string
  diffHunk?: string
}

/** Mirror a GitHub PR comment into the matching Dock artifact. Returns the created
 *  comment (so the caller can fire realtime + notifications), or null when it was
 *  skipped: a bot author (our own write-back or another app — loop prevention), a body
 *  tagged as Dock-originated, an already-mirrored id, or no matching artifact. */
export const ingestGithubPrComment = async (
  meta: MetaStore,
  source: RepoSourceRecord,
  args: IngestArgs,
): Promise<CommentRecord | null> => {
  // Loop prevention: never re-ingest our own write-backs (the App posts as a [bot]
  // account) or anything still carrying our marker.
  if (args.authorType === "Bot" || /\[bot\]$/i.test(args.authorLogin)) return null
  if (args.body.includes(MARK)) return null

  let files: Record<string, { artifact_id: string }>
  try {
    files = JSON.parse(source.files) as Record<string, { artifact_id: string }>
  } catch {
    return null
  }
  // Inline comment → the artifact for its file. Top-level PR comment → the PR preview's
  // first artifact by path (a stable "PR discussion" home; PR-level chatter has no file).
  const paths = Object.keys(files).sort()
  const targetPath = args.kind === "review" && args.path ? args.path : paths[0]
  const artifactId = targetPath ? files[targetPath]?.artifact_id : undefined
  if (!artifactId) return null
  const artifact = await meta.getArtifactById(artifactId)
  if (!artifact) return null

  // Dedupe: if this GitHub comment id is already mirrored on the artifact, skip.
  const existing = await meta.listComments(artifact.id)
  if (existing.some((c) => parseMeta(c.meta).github?.comment_id === args.ghCommentId)) return null

  const quote = args.kind === "review" ? lineFromDiffHunk(args.diffHunk) : null
  const id = newId("c")
  const created = await meta.createComment({
    id,
    artifact_id: artifact.id,
    thread_id: id,
    base_version: artifact.current_version,
    path: args.kind === "review" ? (args.path ?? null) : null,
    anchor: quote ? JSON.stringify({ exact: quote }) : null,
    body_md: args.body,
    author: args.authorLogin,
    author_id: ghAuthorId(args.authorLogin),
  })
  // Stamp GitHub provenance so we never echo it back out + dedupe future deliveries.
  const patched = await meta.updateComment(created.id, {
    meta: JSON.stringify({ github: { comment_id: args.ghCommentId, kind: args.kind } }),
  })
  return patched ?? created
}

/** Build the GitHub-comment delivery sender for a runtime. Mints an installation token
 *  per delivery (cached ~1h by installationToken), posts the comment, and stamps the
 *  Dock comment's `meta.github` with the returned id (dedupe for the inbound webhook).
 *  Returns a no-op-ok when the App/installation isn't available so a self-host without
 *  GitHub configured doesn't dead-letter these rows. */
export const makeGithubCommentSender =
  (meta: MetaStore, encryptionKey: string | undefined) =>
  async (d: DeliveryRecord): Promise<ChannelSendResult> => {
    const p = JSON.parse(d.payload) as GithubCommentPayload
    const repo = parseRepo(p.repo)
    if (!repo) return { ok: true, status: "skipped: unparseable repo" }
    if (!encryptionKey || !p.installationId)
      return { ok: true, status: "skipped: no app/installation" }
    const app = await meta.getGithubApp()
    if (!app) return { ok: true, status: "skipped: no github app" }

    // Idempotency pre-check: if this Dock comment already carries a GitHub id, a prior
    // delivery already posted it (the row was re-claimed after a crash, or double-enqueued)
    // — don't post again. This closes the common duplicate window without an external
    // idempotency key (GitHub has none for comments); a crash strictly between the POST
    // and this stamp can still re-post once, the inherent at-least-once tail.
    const cm = await meta.getComment(p.dockCommentId)
    if (cm && parseMeta(cm.meta).github) return { ok: true, status: "already posted" }

    const pem = decryptSecret(app.private_key, encryptionKey)
    let token: string
    try {
      token = await installationToken(app.app_id, pem, p.installationId)
    } catch (err) {
      // Token minting failures are usually transient (network, clock skew, brief 401);
      // let the outbox retry rather than dead-letter a recoverable connection.
      return { ok: false, status: `token: ${(err as Error).message.slice(0, 160)}` }
    }

    let id: number
    let kind: "issue" | "review"
    try {
      if (d.kind === "github_review_comment" && p.path && p.line && p.commitId) {
        try {
          id = await createReviewComment(
            repo,
            p.prNumber,
            { commitId: p.commitId, path: p.path, line: p.line, body: p.body },
            token,
          )
          kind = "review"
        } catch (err) {
          // The line may not be part of the PR diff (422) — fall back to a top-level PR
          // comment. (Any other status falls through too; the issue-comment call below
          // re-classifies it.)
          if (err instanceof GitHubWriteError && err.status !== 422) throw err
          id = await createIssueComment(repo, p.prNumber, p.body, token)
          kind = "issue"
        }
      } else {
        id = await createIssueComment(repo, p.prNumber, p.body, token)
        kind = "issue"
      }
    } catch (err) {
      const status = err instanceof GitHubWriteError ? err.status : 0
      return {
        ok: false,
        status: (err as Error).message.slice(0, 200),
        permanent: isPermanentStatus(status),
      }
    }

    // Stamp provenance so the inbound webhook dedupes our own post.
    if (cm) {
      await meta.updateComment(cm.id, {
        meta: JSON.stringify({ ...parseMeta(cm.meta), github: { comment_id: id, kind } }),
      })
    }
    return { ok: true, status: `posted ${kind} #${id}` }
  }

import {
  type ArtifactRecord,
  anchorContentFor,
  type CommentRecord,
  isAnchored,
  newId,
} from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import {
  commentJson,
  isCollaboratorAuthor,
  type Mention,
  parseMentions,
  parseMeta,
  quoteOf,
  REACTIONS,
} from "../lib/comments"
import { enqueueGithubPrComment } from "../lib/github-comments"
import { bail, fail, readJson } from "../lib/http"
import { notifyMentions as notifyMentionsShared } from "../lib/mentions"
import { notifyCommentBells } from "../lib/notify-comment"
import { enqueueCommentEmails } from "../lib/notify-email"
import { enqueueSlackComment } from "../lib/slack-comments"
import { enqueueSlackMentionDms } from "../lib/slack-dm"
import { resolveThreadAction } from "../lib/thread-actions"
import { Mention as MentionSchema } from "../schemas"

/** Comments: threaded, anchored to text quotes, with reactions, edits, and soft
 *  deletes. @mentions notify people (bell) or land in an agent's pull inbox. The
 *  Comment response schema is the single source for the web client's type. */
export const commentRoutes = (ctx: AppContext) => {
  const {
    deps,
    meta,
    blobs,
    bus,
    notify,
    background,
    actingUser,
    anonLocked,
    isPrincipal,
    requireArtifact,
    authorize,
    limited,
    commentLimiter,
    anonCommentLimiter,
    sourceText,
  } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  const Comment = z
    .object({
      id: z.string(),
      thread_id: z
        .string()
        .describe("The thread this comment belongs to; equals id for the thread's root comment."),
      base_version: z.number().describe("Artifact version this comment was anchored against."),
      path: z
        .string()
        .nullable()
        .describe("File within a bundle the comment targets; null if not file-scoped."),
      anchor: z
        .string()
        .nullable()
        .describe(
          "Serialized text-quote or element anchor locating the comment; null if unanchored.",
        ),
      body_md: z
        .string()
        .describe("Comment body in Markdown; blanked when the comment is deleted."),
      author: z.string().describe('Author\'s display name; "anonymous" for an anonymous poster.'),
      state: z
        .enum(["open", "addressed", "resolved", "outdated"])
        .describe(
          "Thread state: open, addressed (a proposal in review claims to fix it), resolved, or outdated (the quoted text changed).",
        ),
      created_at: z.string(),
      anchored: z
        .boolean()
        .optional()
        .describe("Whether the anchor still resolves against the current version (list only)."),
      reactions: z
        .record(z.string(), z.array(z.string()))
        .optional()
        .describe("Emoji → list of reactor display names."),
      edited: z.boolean().optional().describe("True if the body was edited after posting."),
      edited_at: z
        .string()
        .nullable()
        .optional()
        .describe("When the comment was last edited; null if never."),
      deleted: z
        .boolean()
        .optional()
        .describe("True if soft-deleted; the row stays but the body is blanked."),
      guest: z
        .boolean()
        .optional()
        .describe("True when the author was an anonymous guest (self-named, no account)."),
      mentions: z
        .array(MentionSchema)
        .optional()
        .describe("Users or agents @mentioned in the comment body."),
    })
    .openapi("Comment")

  // Mention fan-out (bell + realtime + agent inbox) lives in ../lib/mentions so the
  // Slack reply path reuses the same collaborator-gated logic. Bound to this request's
  // meta + bus here.
  const notifyMentions = (
    a: ArtifactRecord,
    cm: CommentRecord,
    mentions: Mention[],
    actorId: string | null,
  ) => notifyMentionsShared({ meta, bus }, a, cm, mentions, actorId)

  // Loads (artifact, comment) for a mutation, 404ing on mismatch. Tagged union so
  // the @hono/zod-openapi handler return type narrows cleanly on `!r.ok`.
  const loadComment = async (
    c: Context,
  ): Promise<
    { ok: true; artifact: ArtifactRecord; cm: CommentRecord } | { ok: false; error: Response }
  > => {
    const artifact = await meta.getByShortId(c.req.param("shortId") ?? "")
    if (!artifact) return { ok: false, error: fail(c, 404, "not found") }
    const cm = await meta.getComment(c.req.param("commentId") ?? "")
    if (!cm || cm.artifact_id !== artifact.id)
      return { ok: false, error: fail(c, 404, "not found") }
    return { ok: true, artifact, cm }
  }
  // The acting display name (agent or signed-in user); null for an anonymous
  // caller — who can't reach any commenting route anyway.
  const actorName = async (c: Context): Promise<string | null> =>
    (await actingUser(c))?.name ?? null

  // Authorship is keyed on the stable actor id, never the mutable display name:
  // renaming your profile to a victim's name must not grant edit/delete rights.
  // Legacy rows (author_id null, written before this column) fall back to the name
  // match so their authors don't lose access. GUEST rows also have a null author_id,
  // but a self-attested guest name is unauthenticated, so they're excluded from the
  // fallback: a member who renames their profile to a guest's display name must not be
  // able to PATCH/DELETE that guest's comment.
  const ownsComment = (cm: CommentRecord, acting: { id: string; name: string }): boolean =>
    cm.author_id
      ? cm.author_id === acting.id
      : !parseMeta(cm.meta).guest && cm.author === acting.name

  // Create a comment (new thread) or a reply (pass thread_id).
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/comments",
      tags: ["Comments"],
      summary: "Post a comment (new thread) or a reply (with thread_id).",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        201: {
          description: "The created comment.",
          content: { "application/json": { schema: Comment } },
        },
      },
    }),
    async (c) => {
      const artifact = await meta.getByShortId(c.req.param("shortId"))
      if (!artifact || artifact.current_version === 0) return bail(fail(c, 404, "not found"))
      if (!(await authorize(c, "comment", artifact))) return bail(fail(c, 403, "forbidden"))
      // "Guest" means genuinely anonymous (no session, agent, or static
      // token) — actingUser is ALSO null for the static-token principal (it
      // authors no byline), so this keys on isPrincipal (true anonymous)
      // rather than `!acting`, preserving the pre-existing token-authenticated
      // body.author/"anonymous" fallback automation relies on. Computed once,
      // up front (isPrincipal is memoized), and reused below both to pick the
      // rate limiter and to gate the name requirement.
      const anon = !(await isPrincipal(c))
      // Guests get a much tighter cap than the signed-in comment rate; keyed
      // by IP via actorKey — a guest thread is a conversation, not a firehose.
      const rl = await limited(c, anon ? anonCommentLimiter : commentLimiter)
      if (rl) return bail(rl)
      const body = await readJson(
        c,
        z
          .object({
            body_md: z
              .string()
              .max(10_000, "comment is too long (max 10000 characters)")
              .refine((s) => s.trim() !== "", "body_md required"),
          })
          .catchall(z.unknown()),
      )
      if (body instanceof Response) return bail(body)

      const id = newId("c")
      const threadId = typeof body.thread_id === "string" && body.thread_id ? body.thread_id : id
      const baseVersion = Number.isInteger(body.base_version)
        ? (body.base_version as number)
        : artifact.current_version
      const anchor =
        body.anchor && typeof body.anchor === "object"
          ? JSON.stringify(body.anchor)
          : typeof body.anchor === "string"
            ? body.anchor
            : null
      // Cap the anchor size. body_md is bounded but the anchor was not — a real element
      // anchor (snapshot.html capped at ~2KB + a few short fields) stays well under this;
      // the limit stops a comment from storing a multi-MB blob that ships on every fetch.
      if (anchor && anchor.length > 16_000)
        return bail(fail(c, 400, "anchor is too large (max 16000 characters)"))

      const acting = await actingUser(c)
      // A signed-in author is always the session identity; a guest MUST name
      // themself (the UI requires it; the API enforces it). Names are display-
      // only — authorization never keys on them. `anon` was resolved above
      // (before the rate-limit check).
      const guestName = typeof body.author === "string" ? body.author.trim() : ""
      if (anon && !guestName) return bail(fail(c, 400, "name required"))
      if (anon && guestName.length > 80)
        return bail(fail(c, 400, "name is too long (max 80 characters)"))
      const author = acting ? acting.name : guestName || "anonymous"
      const mentions = parseMentions(body.mentions)

      let created = await meta.createComment({
        id,
        artifact_id: artifact.id,
        thread_id: threadId,
        base_version: baseVersion,
        path: typeof body.path === "string" ? body.path : null,
        anchor,
        body_md: body.body_md,
        author,
        author_id: acting?.id ?? null,
      })
      // Mentions live in the comment's meta JSON (the picker supplies user ids, so
      // there's no fragile server-side @name parsing); persist them with the row.
      const metaPatch: Record<string, unknown> = {}
      if (mentions.length) metaPatch.mentions = mentions
      // Stamp guest authorship at write time: author_id is null for legacy
      // signed-in rows AND token-authenticated automation too, so rendering
      // keys on this explicit flag instead.
      if (anon) metaPatch.guest = true
      if (Object.keys(metaPatch).length) {
        const patched = await meta.updateComment(created.id, {
          meta: JSON.stringify({ ...parseMeta(created.meta), ...metaPatch }),
        })
        if (patched) created = patched
      }
      // Signal-only: never put the comment body on the realtime bus. Clients refetch
      // /comments, readable only by callers who can comment (members, or guests on a
      // commenter+ link) and never a viewer/none visitor, so the content can't leak to
      // an unentitled SSE subscriber. Webhooks carry their own payload via notify() below.
      // The realtime signal goes out now (cheap, in-process); everyone watching
      // refetches. The webhook enqueues and mention notifications are best-effort
      // fan-out, so they run after the response instead of stacking sequential D1
      // round-trips onto the post (the "couple of seconds to send" people felt).
      bus.publish(artifact.id, { type: "comment.created" })
      await background(
        (async () => {
          await notify(artifact, "comment.created", {
            author: created.author,
            body: created.body_md,
            quote: quoteOf(created.anchor),
            thread_id: created.thread_id,
          })
          const notified = await notifyMentions(artifact, created, mentions, acting?.id ?? null)
          if (notified.length) {
            await notify(artifact, "comment.mention", {
              author: created.author,
              mentioned: notified,
              body: created.body_md,
              quote: quoteOf(created.anchor),
              thread_id: created.thread_id,
            })
            // DM opted-in teammates who were mentioned (resolved by email at delivery time).
            await enqueueSlackMentionDms(
              { meta, baseUrl: deps.baseUrl },
              artifact,
              created,
              mentions.filter((m) => m.id !== acting?.id),
            )
          }
          // Bell the comment's natural audience — thread participants + the
          // artifact's owners (your content) — shared with the MCP path.
          await notifyCommentBells({ meta, bus }, artifact, created, {
            mentionIds: new Set(mentions.map((m) => m.id)),
            actorId: acting?.id ?? null,
          })
          // Channel fan-out is gated per workspace (Settings -> integrations toggles).
          const settings = await meta.getOrgSettings(artifact.org_id)
          if (settings.emailNotifications)
            await enqueueCommentEmails({ meta, baseUrl: deps.baseUrl }, artifact, created, {
              mentionIds: new Set(mentions.map((m) => m.id)),
              actorId: acting?.id ?? null,
            })
          const trustedAuthor = await isCollaboratorAuthor(meta, artifact, acting?.id ?? null)
          if (trustedAuthor && settings.githubPostComments)
            await enqueueGithubPrComment({ meta, blobs, baseUrl: deps.baseUrl }, artifact, created)
          if (trustedAuthor && settings.slackPost)
            await enqueueSlackComment({ meta, baseUrl: deps.baseUrl }, artifact, created)
          deps.pokeWebhooks?.()
        })(),
      )
      return c.json(commentJson(created), 201)
    },
  )

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/artifacts/{shortId}/comments",
      tags: ["Comments"],
      summary:
        "List an artifact's comments (authenticated readers, or anon guests on a commenter+ link).",
      request: {
        params: z.object({ shortId: z.string() }),
        query: z.object({
          state: z.enum(["open", "resolved", "outdated", "addressed"]).optional(),
        }),
      },
      responses: {
        200: {
          description: "The artifact's comments, each flagged whether its anchor still resolves.",
          content: { "application/json": { schema: z.object({ comments: z.array(Comment) }) } },
        },
      },
    }),
    async (c) => {
      const artifact = await requireArtifact(c, "read")
      if (artifact instanceof Response) return bail(artifact)
      // Comments are collaboration, not content: anonymous visitors on a
      // viewer/none link never see them. A commenter+ link admits guests to
      // the conversation they can write into, so the gate is "can comment",
      // not "has an account".
      if ((await anonLocked(c, artifact)) && !(await authorize(c, "comment", artifact)))
        return bail(fail(c, 404, "not found"))
      // state is validated by the route's query contract (the enum above): an
      // out-of-enum ?state= is rejected with a 400 before we reach here, so consume
      // the typed value directly rather than re-coercing. Absent ⇒ undefined ⇒ all.
      const { state } = c.req.valid("query")
      const comments = await meta.listComments(artifact.id, { state })
      // Flag whether each anchor still resolves against the current version. Build the
      // anchor content once (tag-stripping HTML for text-quote matching) and reuse it.
      const cur = await meta.getVersion(artifact.id, artifact.current_version)
      const raw = cur ? await sourceText(cur) : null
      const content = raw === null ? null : anchorContentFor(raw, cur?.content_type ?? "")
      return c.json({
        comments: comments.map((cm) =>
          commentJson(cm, content === null ? true : isAnchored(cm.anchor, content)),
        ),
      })
    },
  )

  // Resolve (or reopen, with {state:"open"}) the thread a comment belongs to.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/comments/{commentId}/resolve",
      tags: ["Comments"],
      summary: "Resolve or reopen the thread a comment belongs to.",
      request: { params: z.object({ shortId: z.string(), commentId: z.string() }) },
      responses: {
        200: {
          description: "The thread's new state.",
          content: {
            "application/json": {
              schema: z.object({
                thread_id: z.string(),
                state: z
                  .enum(["open", "resolved"])
                  .describe("The thread's new state: resolved, or open when reopened."),
                updated: z
                  .number()
                  .describe("Number of comments in the thread whose state changed."),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const artifact = await requireArtifact(c, "comment", { split: true })
      if (artifact instanceof Response) return bail(artifact)
      // Route-level defense in depth: authorize("comment") now passes for anon guests
      // (create is their one allowed mutation, gated at the door). Resolve/react/edit/
      // delete are principal-only; never rely on the door regex alone to block them.
      if (!(await isPrincipal(c))) return bail(fail(c, 403, "forbidden"))
      const cm = await meta.getComment(c.req.param("commentId"))
      if (!cm || cm.artifact_id !== artifact.id) return bail(fail(c, 404, "not found"))
      const body = await readJson(c, z.object({ state: z.string().optional() }))
      if (body instanceof Response) return bail(body)
      const state: "open" | "resolved" = body.state === "open" ? "open" : "resolved"
      const updated = await resolveThreadAction(
        { meta, bus, notify },
        artifact,
        cm.thread_id,
        state,
      )
      return c.json({ thread_id: cm.thread_id, state, updated })
    },
  )

  // Toggle the current user's reaction (one of REACTIONS) on a comment.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/comments/{commentId}/react",
      tags: ["Comments"],
      summary: "Toggle a reaction on a comment.",
      request: { params: z.object({ shortId: z.string(), commentId: z.string() }) },
      responses: {
        200: {
          description: "The updated comment.",
          content: { "application/json": { schema: Comment } },
        },
      },
    }),
    async (c) => {
      const r = await loadComment(c)
      if (!r.ok) return bail(r.error)
      const { artifact, cm } = r
      if (!(await authorize(c, "comment", artifact))) return bail(fail(c, 403, "forbidden"))
      // Principal-only (see resolve): a guest never reacts, edits, or deletes.
      if (!(await isPrincipal(c))) return bail(fail(c, 403, "forbidden"))
      const body = await readJson(
        c,
        z.object({ emoji: z.string().refine((e) => REACTIONS.includes(e), "unknown reaction") }),
      )
      if (body instanceof Response) return bail(body)
      const actor = (await actorName(c)) ?? "anonymous"
      const md = parseMeta(cm.meta)
      const reactions = md.reactions ?? {}
      const arr = reactions[body.emoji] ?? []
      const i = arr.indexOf(actor)
      if (i >= 0) arr.splice(i, 1)
      else arr.push(actor)
      if (arr.length) reactions[body.emoji] = arr
      else delete reactions[body.emoji]
      md.reactions = reactions
      const updated = await meta.updateComment(cm.id, { meta: JSON.stringify(md) })
      bus.publish(artifact.id, { type: "comment.reacted", thread_id: cm.thread_id })
      return c.json(commentJson(updated ?? cm))
    },
  )

  // Edit a comment's body (author only when signed in).
  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/artifacts/{shortId}/comments/{commentId}",
      tags: ["Comments"],
      summary: "Edit a comment's body (author only).",
      request: { params: z.object({ shortId: z.string(), commentId: z.string() }) },
      responses: {
        200: {
          description: "The edited comment.",
          content: { "application/json": { schema: Comment } },
        },
      },
    }),
    async (c) => {
      const r = await loadComment(c)
      if (!r.ok) return bail(r.error)
      const { artifact, cm } = r
      if (!(await authorize(c, "comment", artifact))) return bail(fail(c, 403, "forbidden"))
      // Principal-only (see resolve): a guest never edits.
      if (!(await isPrincipal(c))) return bail(fail(c, 403, "forbidden"))
      const acting = await actingUser(c)
      if (acting && !ownsComment(cm, acting)) return bail(fail(c, 403, "forbidden"))
      const body = await readJson(
        c,
        z.object({
          body_md: z
            .string()
            .max(10_000, "comment is too long (max 10000 characters)")
            .refine((s) => s.trim() !== "", "body_md required"),
        }),
      )
      if (body instanceof Response) return bail(body)
      const md = parseMeta(cm.meta)
      md.edited_at = new Date().toISOString()
      const updated = await meta.updateComment(cm.id, {
        body_md: body.body_md,
        meta: JSON.stringify(md),
      })
      bus.publish(artifact.id, { type: "comment.updated", thread_id: cm.thread_id })
      return c.json(commentJson(updated ?? cm))
    },
  )

  // Delete a comment (author only when signed in). A tombstone only earns its keep
  // when there are replies to hold the thread together, so we keep it conditional: if
  // another live comment survives in the thread, tombstone this one (row stays, body
  // blanked); if it was the thread's LAST living comment, remove the whole thread
  // instead — otherwise a solo delete leaves a "Comment deleted" ghost pinned to the
  // document with an orphaned highlight and a dangling notification. Either way the
  // response describes the comment's final (deleted) state.
  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/artifacts/{shortId}/comments/{commentId}",
      tags: ["Comments"],
      summary: "Delete a comment (author only); tombstoned if replies remain, else removed.",
      request: { params: z.object({ shortId: z.string(), commentId: z.string() }) },
      responses: {
        200: {
          description: "The comment's final deleted state.",
          content: { "application/json": { schema: Comment } },
        },
      },
    }),
    async (c) => {
      const r = await loadComment(c)
      if (!r.ok) return bail(r.error)
      const { artifact, cm } = r
      if (!(await authorize(c, "comment", artifact))) return bail(fail(c, 403, "forbidden"))
      // Principal-only (see resolve): a guest never deletes.
      if (!(await isPrincipal(c))) return bail(fail(c, 403, "forbidden"))
      const acting = await actingUser(c)
      if (acting && !ownsComment(cm, acting)) return bail(fail(c, 403, "forbidden"))
      const md = parseMeta(cm.meta)
      md.deleted = true
      // Tombstone FIRST, then re-read the thread. Writing before the survivor check is what
      // makes this race-safe WITHOUT a cross-request transaction: if two authors delete the
      // last two live comments at once, each re-reads only AFTER its own tombstone commits,
      // so at least one of them observes the other's tombstone and sees a fully-dead thread.
      // (A check-then-write order would let both see the other as "alive" and both tombstone,
      // reviving the very "Comment deleted" ghost this removes.)
      await meta.updateComment(cm.id, { meta: JSON.stringify(md) })
      // Any comment in this thread still carrying content? cm is now tombstoned, so the
      // `deleted` check already excludes it. Threads are small — one list + filter beats a
      // dedicated query path.
      const live = (await meta.listComments(artifact.id)).filter(
        (x) => x.thread_id === cm.thread_id && !parseMeta(x.meta).deleted,
      )
      // Nothing anchors to the thread anymore → remove it whole (comments + notifications +
      // agent mentions + Slack link) rather than leave a ghost pinned to the document. When
      // two deletes race here, both may run this; deleteThread is idempotent.
      if (live.length === 0) await meta.deleteThread(artifact.id, cm.thread_id)
      bus.publish(artifact.id, { type: "comment.updated", thread_id: cm.thread_id })
      return c.json(commentJson({ ...cm, meta: JSON.stringify(md) }))
    },
  )

  return app
}

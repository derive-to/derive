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
  previewOf,
  quoteOf,
  REACTIONS,
} from "../lib/comments"
import { enqueueGithubPrComment } from "../lib/github-comments"
import { bail, fail, readJson } from "../lib/http"
import { enqueueCommentEmails } from "../lib/notify-email"
import { enqueueSlackComment } from "../lib/slack-comments"
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
    requireArtifact,
    authorize,
    limited,
    commentLimiter,
    sourceText,
  } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  const Comment = z
    .object({
      id: z.string(),
      thread_id: z.string(),
      base_version: z.number(),
      path: z.string().nullable(),
      anchor: z.string().nullable(),
      body_md: z.string(),
      author: z.string(),
      state: z.enum(["open", "addressed", "resolved", "outdated"]),
      created_at: z.string(),
      /** Whether the anchor still resolves against the current version (list only). */
      anchored: z.boolean().optional(),
      reactions: z.record(z.string(), z.array(z.string())).optional(),
      edited: z.boolean().optional(),
      edited_at: z.string().nullable().optional(),
      deleted: z.boolean().optional(),
      mentions: z.array(MentionSchema).optional(),
    })
    .openapi("Comment")

  // Create in-app notification rows for the people a comment @mentions (real
  // users only, never the author) and push each a live event over their stream.
  // Returns the display names actually notified (for the Slack webhook).
  const notifyMentions = async (
    a: ArtifactRecord,
    cm: CommentRecord,
    mentions: Mention[],
    actorId: string | null,
  ): Promise<string[]> => {
    const targetIds = mentions.map((m) => m.id).filter((mid) => mid !== actorId)
    if (targetIds.length === 0) return []
    const real = new Set((await meta.getUsers(targetIds)).map((u) => u.id))
    // Registered agents are mentionable too; a mention of an agent lands in its
    // pull inbox instead of a notification bell.
    const agentIds = new Set((await meta.listAgents(a.org_id)).map((ag) => ag.id))
    // A mention only notifies someone who can actually SEE the artifact: a member
    // of its workspace or an explicit share recipient (the collaborator set, like
    // the B-012/B-013 roster gate). The `mentions[]` array is client-supplied, so
    // without this any user could push a notification carrying attacker-controlled
    // title/preview to ANY other user — cross-workspace spam/phishing into the bell
    // + SSE. "Could view a public artifact" is intentionally NOT enough; a real
    // collaboration mention means a member/share, not a stranger.
    const collaborators = new Set<string>([
      ...(await meta.listMemberships(a.org_id)).map((m) => m.user_id),
      ...(await meta.listArtifactMembers(a.id)).map((r) => r.user_id),
    ])
    const preview = previewOf(cm.body_md)
    const notified: string[] = []
    for (const m of mentions) {
      if (m.id === actorId) continue
      if (real.has(m.id) && collaborators.has(m.id)) {
        const row = {
          id: newId("n"),
          user_id: m.id,
          actor: cm.author,
          kind: "mention" as const,
          artifact_id: a.id,
          artifact_short_id: a.short_id,
          artifact_title: a.title,
          thread_id: cm.thread_id,
          comment_id: cm.id,
          preview,
        }
        await meta.createNotification(row)
        notified.push(m.name)
        bus.publish(`u:${m.id}`, {
          type: "notification",
          notification: { ...row, read: 0, created_at: new Date().toISOString() },
        })
      } else if (agentIds.has(m.id)) {
        await meta.createAgentMention({
          id: newId("amn"),
          agent_id: m.id,
          artifact_id: a.id,
          artifact_short_id: a.short_id,
          comment_id: cm.id,
          thread_id: cm.thread_id,
          body: cm.body_md,
          author: cm.author,
        })
        notified.push(m.name)
      }
    }
    return notified
  }

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
  // Legacy rows (author_id null, written before this column) fall back to the
  // name match so their authors don't lose access.
  const ownsComment = (cm: CommentRecord, acting: { id: string; name: string }): boolean =>
    cm.author_id ? cm.author_id === acting.id : cm.author === acting.name

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
      const rl = await limited(c, commentLimiter)
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
      const author = acting
        ? acting.name
        : typeof body.author === "string" && body.author
          ? body.author
          : "anonymous"
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
      if (mentions.length) {
        const patched = await meta.updateComment(created.id, {
          meta: JSON.stringify({ ...parseMeta(created.meta), mentions }),
        })
        if (patched) created = patched
      }
      // Signal-only: never put the comment body on the realtime bus. Clients refetch
      // /comments (which is account-gated), so the content can't leak to an anonymous
      // SSE subscriber. Webhooks carry their own payload via notify() below.
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
          if (notified.length)
            await notify(artifact, "comment.mention", {
              author: created.author,
              mentioned: notified,
              body: created.body_md,
              quote: quoteOf(created.anchor),
              thread_id: created.thread_id,
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
      summary: "List an artifact's comments (authenticated readers only).",
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
      // Comments are collaboration, not content: anonymous visitors (no account) never
      // see them, even on a public link. Authenticated readers — including a plain
      // viewer — do, the Google-Docs way. So the gate is "has an account", not the role.
      if (await anonLocked(c, artifact)) return bail(fail(c, 404, "not found"))
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
                state: z.enum(["open", "resolved"]),
                updated: z.number(),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const artifact = await meta.getByShortId(c.req.param("shortId"))
      if (!artifact) return bail(fail(c, 404, "not found"))
      if (!(await authorize(c, "comment", artifact))) return bail(fail(c, 403, "forbidden"))
      const cm = await meta.getComment(c.req.param("commentId"))
      if (!cm || cm.artifact_id !== artifact.id) return bail(fail(c, 404, "not found"))
      const body = await readJson(c, z.object({ state: z.string().optional() }))
      if (body instanceof Response) return bail(body)
      const state: "open" | "resolved" = body.state === "open" ? "open" : "resolved"
      const updated = await meta.setThreadState(artifact.id, cm.thread_id, state)
      bus.publish(artifact.id, { type: "comment.resolved", thread_id: cm.thread_id, state })
      await notify(artifact, "comment.resolved", { state, thread_id: cm.thread_id })
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

  // Soft-delete a comment (author only when signed in); the row stays so replies
  // keep their thread, and the body is tombstoned.
  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/artifacts/{shortId}/comments/{commentId}",
      tags: ["Comments"],
      summary: "Soft-delete a comment (author only); the row stays, body tombstoned.",
      request: { params: z.object({ shortId: z.string(), commentId: z.string() }) },
      responses: {
        200: {
          description: "The tombstoned comment.",
          content: { "application/json": { schema: Comment } },
        },
      },
    }),
    async (c) => {
      const r = await loadComment(c)
      if (!r.ok) return bail(r.error)
      const { artifact, cm } = r
      if (!(await authorize(c, "comment", artifact))) return bail(fail(c, 403, "forbidden"))
      const acting = await actingUser(c)
      if (acting && !ownsComment(cm, acting)) return bail(fail(c, 403, "forbidden"))
      const md = parseMeta(cm.meta)
      md.deleted = true
      const updated = await meta.updateComment(cm.id, { meta: JSON.stringify(md) })
      bus.publish(artifact.id, { type: "comment.updated", thread_id: cm.thread_id })
      return c.json(commentJson(updated ?? cm))
    },
  )

  return app
}

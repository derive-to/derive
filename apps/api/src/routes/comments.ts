import { type ArtifactRecord, type CommentRecord, isAnchored, newId } from "@dock/core"
import { type Context, Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import {
  commentJson,
  type Mention,
  parseMentions,
  parseMeta,
  previewOf,
  quoteOf,
  REACTIONS,
} from "../lib/comments"
import { fail, readJson } from "../lib/http"

/** Comments: threaded, anchored to text quotes, with reactions, edits, and soft
 *  deletes. @mentions notify people (bell) or land in an agent's pull inbox. */
export const commentRoutes = (ctx: AppContext) => {
  const {
    meta,
    bus,
    notify,
    actingUser,
    anonLocked,
    authorize,
    limited,
    commentLimiter,
    sourceText,
  } = ctx
  const app = new Hono()

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
    const preview = previewOf(cm.body_md)
    const notified: string[] = []
    for (const m of mentions) {
      if (m.id === actorId) continue
      if (real.has(m.id)) {
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

  // Loads (artifact, comment) for a mutation, 404ing on mismatch.
  const loadComment = async (
    c: Context,
  ): Promise<{ artifact: ArtifactRecord; cm: CommentRecord } | { error: Response }> => {
    const artifact = await meta.getByShortId(c.req.param("shortId") ?? "")
    if (!artifact) return { error: fail(c, 404, "not found") }
    const cm = await meta.getComment(c.req.param("commentId") ?? "")
    if (!cm || cm.artifact_id !== artifact.id) return { error: fail(c, 404, "not found") }
    return { artifact, cm }
  }
  // The acting display name (agent or signed-in user); null for an anonymous
  // caller — who can't reach any commenting route anyway.
  const actorName = async (c: Context): Promise<string | null> =>
    (await actingUser(c))?.name ?? null

  // Create a comment (new thread) or a reply (pass thread_id).
  app.post("/v1/artifacts/:shortId/comments", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || artifact.current_version === 0) return fail(c, 404, "not found")
    if (!(await authorize(c, "comment", artifact))) return fail(c, 403, "forbidden")
    const rl = await limited(c, commentLimiter)
    if (rl) return rl
    const body = await readJson(
      c,
      z
        .object({ body_md: z.string().refine((s) => s.trim() !== "", "body_md required") })
        .catchall(z.unknown()),
    )
    if (body instanceof Response) return body

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
    bus.publish(artifact.id, { type: "comment.created" })
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
    return c.json(commentJson(created), 201)
  })

  app.get("/v1/artifacts/:shortId/comments", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact))) return fail(c, 404, "not found")
    // Comments are collaboration, not content: anonymous visitors (no account) never
    // see them, even on a public link. Authenticated readers — including a plain
    // viewer — do, the Google-Docs way. So the gate is "has an account", not the role.
    if (await anonLocked(c, artifact)) return fail(c, 404, "not found")
    const q = c.req.query("state")
    const state = q === "open" || q === "resolved" ? q : undefined
    const comments = await meta.listComments(artifact.id, state ? { state } : undefined)
    // Flag whether each anchor still resolves against the current version.
    const cur = await meta.getVersion(artifact.id, artifact.current_version)
    const src = cur ? await sourceText(cur) : null
    return c.json({
      comments: comments.map((cm) =>
        commentJson(cm, src === null ? true : isAnchored(cm.anchor, src)),
      ),
    })
  })

  // Resolve (or reopen, with {state:"open"}) the thread a comment belongs to.
  app.post("/v1/artifacts/:shortId/comments/:commentId/resolve", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return fail(c, 404, "not found")
    if (!(await authorize(c, "comment", artifact))) return fail(c, 403, "forbidden")
    const cm = await meta.getComment(c.req.param("commentId"))
    if (!cm || cm.artifact_id !== artifact.id) return fail(c, 404, "not found")
    const body = await readJson(c, z.object({ state: z.string().optional() }))
    if (body instanceof Response) return body
    const state = body.state === "open" ? "open" : "resolved"
    const updated = await meta.setThreadState(artifact.id, cm.thread_id, state)
    bus.publish(artifact.id, { type: "comment.resolved", thread_id: cm.thread_id, state })
    await notify(artifact, "comment.resolved", { state, thread_id: cm.thread_id })
    return c.json({ thread_id: cm.thread_id, state, updated })
  })

  // Toggle the current user's reaction (one of REACTIONS) on a comment.
  app.post("/v1/artifacts/:shortId/comments/:commentId/react", async (c) => {
    const r = await loadComment(c)
    if ("error" in r) return r.error
    const { artifact, cm } = r
    if (!(await authorize(c, "comment", artifact))) return fail(c, 403, "forbidden")
    const body = await readJson(
      c,
      z.object({ emoji: z.string().refine((e) => REACTIONS.includes(e), "unknown reaction") }),
    )
    if (body instanceof Response) return body
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
  })

  // Edit a comment's body (author only when signed in).
  app.patch("/v1/artifacts/:shortId/comments/:commentId", async (c) => {
    const r = await loadComment(c)
    if ("error" in r) return r.error
    const { artifact, cm } = r
    if (!(await authorize(c, "comment", artifact))) return fail(c, 403, "forbidden")
    const actor = await actorName(c)
    if (actor && cm.author !== actor) return fail(c, 403, "forbidden")
    const body = await readJson(
      c,
      z.object({ body_md: z.string().refine((s) => s.trim() !== "", "body_md required") }),
    )
    if (body instanceof Response) return body
    const md = parseMeta(cm.meta)
    md.edited_at = new Date().toISOString()
    const updated = await meta.updateComment(cm.id, {
      body_md: body.body_md,
      meta: JSON.stringify(md),
    })
    bus.publish(artifact.id, { type: "comment.updated", thread_id: cm.thread_id })
    return c.json(commentJson(updated ?? cm))
  })

  // Soft-delete a comment (author only when signed in); the row stays so replies
  // keep their thread, and the body is tombstoned.
  app.delete("/v1/artifacts/:shortId/comments/:commentId", async (c) => {
    const r = await loadComment(c)
    if ("error" in r) return r.error
    const { artifact, cm } = r
    if (!(await authorize(c, "comment", artifact))) return fail(c, 403, "forbidden")
    const actor = await actorName(c)
    if (actor && cm.author !== actor) return fail(c, 403, "forbidden")
    const md = parseMeta(cm.meta)
    md.deleted = true
    const updated = await meta.updateComment(cm.id, { meta: JSON.stringify(md) })
    bus.publish(artifact.id, { type: "comment.updated", thread_id: cm.thread_id })
    return c.json(commentJson(updated ?? cm))
  })

  return app
}

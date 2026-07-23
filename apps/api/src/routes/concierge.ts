import { newId, publish } from "@derive/core"
import { Hono } from "hono"
import type { AppContext } from "../context"

// WP7 — the concierge. A new user's first session should close the loop once:
// they land on a seeded welcome artifact that already carries a planted comment,
// they (or the workspace's fallback agent) address it, and v2 appears at the
// same URL. This endpoint seeds that artifact + comment. The web welcome flow
// calls it once; a re-call returns the existing seed instead of duplicating.

const WELCOME_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Welcome to Derive</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#0a0b0d;color:#f3f4f6;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;line-height:1.6}
  .wrap{max-width:640px;margin:0 auto;padding:64px 28px}
  h1{font-size:34px;letter-spacing:-.02em;margin:0 0 16px}
  p{color:#969aa2;font-size:16px}
  b{color:#f3f4f6;font-weight:600}
  .loop{margin-top:28px;padding:18px 20px;border:1px solid #23252b;border-radius:10px;background:#101216}
</style></head>
<body><div class="wrap">
  <h1>Welcome to Derive</h1>
  <p>This is a real artifact at a permanent, versioned URL. Everything an agent
  ships lands here: owned by you, reviewable, and kept as history.</p>
  <div class="loop">
    <p style="margin:0"><b>Try the loop.</b> There's a comment on this page. Tell your
    agent to catch up on Derive, and watch it revise this document into a new version
    at the same URL. That is the whole product in one gesture.</p>
  </div>
</div></body></html>`

const PLANTED_COMMENT = `Welcome! Here's your first task for the loop: add a short, warm
one-line greeting to the top of this page that mentions the reader by name. When you're
done, this comment resolves and the page becomes v2 at the same URL, a new version.`

const WELCOME_TITLE = "Welcome to Derive"

export const conciergeRoutes = (ctx: AppContext) => {
  const { meta, blobs, requireUser, activeWorkspace } = ctx
  const app = new Hono()

  app.post("/v1/workspace/concierge", async (c) => {
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const org = await activeWorkspace(c)

    // Idempotent: the web welcome flow can fire more than once (a retry, a second
    // tab, a re-signin). If this user already holds a welcome seed in this
    // workspace, return it rather than planting another. Keyed on the owner
    // roster (written at creation) + the seed title, not the mutable author_id.
    const ownedIds = await meta.artifactIdsOwnedBy(org, me.id)
    const owned = ownedIds.length ? await meta.getArtifactsByIds(ownedIds) : []
    const seed = owned.find((a) => a.title === WELCOME_TITLE)
    if (seed) {
      const existing = await meta.listComments(seed.id)
      return c.json(
        { short_id: seed.short_id, comment_thread: existing[0]?.thread_id ?? null, existing: true },
        200,
      )
    }

    // The planted comment is authored by the workspace's fallback agent when one
    // is set (so an agent-less user still gets a first loop), else a neutral
    // "Derive" note. Either way it's a task the loop closes.
    const settings = await meta.getOrgSettings(org)
    const agents = settings.defaultAgentId ? await meta.listAgents(org) : []
    const fallback = agents.find((a) => a.id === settings.defaultAgentId)

    const { artifact, version } = await publish(meta, blobs, {
      bytes: new TextEncoder().encode(WELCOME_HTML),
      filename: "index.html",
      isBundle: false,
      title: WELCOME_TITLE,
      author: me.name ?? "You",
      authorId: me.id,
      source: "web",
      orgId: org,
      // The team draft: a workspace teammate (or the on-behalf agent) can open it,
      // the world can't, nothing is listed until the user promotes it.
      workspaceAccess: "member",
      linkRole: "none",
      listed: "none",
    })

    // Put the user on the artifact's owner roster — the same one row the publish
    // route writes — so the seed is genuinely theirs (shows in "Created by me")
    // and the idempotency check above can find it on a re-fire.
    await meta.setArtifactMember({
      id: newId("am"),
      artifact_id: artifact.id,
      user_id: me.id,
      role: "owner",
    })

    const thread = newId("th")
    await meta.createComment({
      id: newId("c"),
      artifact_id: artifact.id,
      thread_id: thread,
      base_version: version.n,
      body_md: PLANTED_COMMENT,
      author: fallback?.name ?? "Derive",
      author_id: fallback?.id ?? null,
    })

    return c.json({ short_id: artifact.short_id, comment_thread: thread }, 201)
  })

  return app
}

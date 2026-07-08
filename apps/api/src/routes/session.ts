import { can, normalizeUsername, toJson, usernameError } from "@derive/core"
import { type Context, Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { authorProfile, resolveHandles } from "../lib/author"
import { fail, IMMUTABLE_CACHE, readJson, toBody } from "../lib/http"
import { MAX_AVATAR_BYTES, sniffImageType } from "../lib/image"

/** Session identity + the workspace member/agent directory for the @mention picker. */
export const sessionRoutes = (ctx: AppContext) => {
  const {
    meta,
    blobs,
    deps,
    isMember,
    isToken,
    requireUser,
    currentUser,
    ensureMembership,
    activeWorkspace,
    authorize,
    actorFor,
    analyticsOn,
  } = ctx
  const app = new Hono()

  app.get("/v1/me", async (c) => {
    const u = await requireUser(c)
    if (u instanceof Response) return u
    const role = await ensureMembership(await activeWorkspace(c), u.id) // provisions on first load
    return c.json({ user: { ...u, role }, multi: true })
  })

  // Claim or change your handle (Profiles & Accounts v1) — the prompt shown at
  // onboarding, and re-runnable to rename later. Server-validated (shape +
  // reserved words) and lowercased before storage; a clash with another account
  // is a 409. Only the signed-in user can set their own (the anon-write lockdown
  // already blocks unauthenticated POSTs).
  app.post("/v1/me/username", async (c) => {
    const u = await requireUser(c)
    if (u instanceof Response) return u
    const body = await readJson(c, z.object({ username: z.string() }))
    if (body instanceof Response) return body
    const username = normalizeUsername(body.username)
    const err = usernameError(username)
    if (err) return fail(c, 400, err)
    const res = await meta.setUsername(u.id, username)
    if (res === "taken") return fail(c, 409, "That username is taken.")
    return c.json({ username })
  })

  // Set your team role + "what you do" blurb (Settings → Profile, and onboarding).
  // A coarse role (free string so "Other" can be anything) plus a one-line bio,
  // both optional. Server-set only (signed-in user edits their own). An omitted
  // field is left untouched; an empty string clears it.
  app.post("/v1/me/profile", async (c) => {
    const u = await requireUser(c)
    if (u instanceof Response) return u
    const body = await readJson(
      c,
      z.object({
        profession: z.string().trim().max(40).optional(),
        about: z.string().trim().max(280).optional(),
      }),
    )
    if (body instanceof Response) return body
    // Normalize "" → null (clear) so the column is never an empty string.
    const patch: { profession?: string | null; about?: string | null } = {}
    if (body.profession !== undefined) patch.profession = body.profession || null
    if (body.about !== undefined) patch.about = body.about || null
    await meta.setUserProfile(u.id, patch)
    return c.json({ profession: patch.profession ?? null, about: patch.about ?? null })
  })

  // Opt in/out of being findable. On by default (auth-config sets it at signup and
  // the queries treat unset as on). Turning it OFF is real privacy, not just
  // directory removal: the profile page, work list, and follow lists all 404 for
  // anyone who doesn't share a workspace (see profileVisibleTo below).
  app.post("/v1/me/discoverable", async (c) => {
    const u = await requireUser(c)
    if (u instanceof Response) return u
    const body = await readJson(c, z.object({ discoverable: z.boolean() }))
    if (body instanceof Response) return body
    await meta.setUserDiscoverable(u.id, body.discoverable)
    return c.json({ discoverable: body.discoverable })
  })

  // Mark first-run onboarding finished (or skipped) — server-authoritative so the
  // /welcome gate stays consistent across devices and a cleared localStorage can't
  // re-trigger it. One-way (you never un-onboard), so it takes no body. Signed-in only
  // (the anon write-lockdown already blocks unauthenticated POSTs).
  app.post("/v1/me/onboarded", async (c) => {
    const u = await requireUser(c)
    if (u instanceof Response) return u
    await meta.setUserOnboarded(u.id, true)
    return c.json({ onboarded: true })
  })

  // People search: find OPTED-IN accounts by handle or name (GitHub-style "add by
  // username"). Only users who turned on discoverability appear, and only the
  // public fields (handle, name, avatar) come back — never email. Signed-in only,
  // and an empty query returns nothing, so it can't be used to enumerate everyone.
  // Registered before /v1/users/:handle so "search" isn't read as a handle.
  app.get("/v1/users/search", async (c) => {
    if (!(await currentUser(c))) return fail(c, 401, "unauthenticated")
    const q = (c.req.query("query") ?? "").trim()
    if (!q) return c.json({ users: [] })
    const found = await meta.searchDiscoverableUsers(q, 20)
    return c.json({
      users: found.map((u) => ({
        username: u.username,
        name: u.name,
        image: u.image,
        profession: u.profession ?? null,
      })),
    })
  })

  // The People page's data — the people you actually work with (any shared
  // workspace), discoverable or not: membership already implies you can see each
  // other. There is deliberately no global directory here — People is work
  // awareness, not a social network (addressing a stranger to SHARE with them
  // still works via /v1/users/search, which never enumerates). `?query=` filters
  // within your workmates. Signed-in only; public fields only — never email.
  app.get("/v1/people", async (c) => {
    const me = await currentUser(c)
    if (!me) return fail(c, 401, "unauthenticated")
    const q = (c.req.query("query") ?? "").trim().toLowerCase()
    const mates = await meta.listWorkspaceMates(me.id, 60)
    const found = q
      ? mates.filter(
          (u) =>
            u.username?.toLowerCase().includes(q) ||
            u.name?.toLowerCase().includes(q) ||
            u.profession?.toLowerCase().includes(q),
        )
      : mates
    return c.json({
      users: found.map((u) => ({
        username: u.username,
        name: u.name,
        image: u.image,
        profession: u.profession ?? null,
      })),
    })
  })

  // Whether this viewer may see this profile at all. Discoverable (the default) ⇒
  // yes, anyone — a public artifact's author chip must resolve to a profile.
  // Discoverable OFF ⇒ only the person themselves and people who share a workspace
  // with them; everyone else gets the same 404 as an unknown handle, so an opted-out
  // account can't be confirmed to exist by probing handles.
  const profileVisibleTo = async (
    c: Context,
    p: { id: string; discoverable?: boolean | number | null },
  ): Promise<boolean> => {
    if (p.discoverable !== false && p.discoverable !== 0) return true
    const me = await currentUser(c)
    if (!me) return false
    if (me.id === p.id) return true
    return (await meta.sharedOrgIds(me.id, p.id)).length > 0
  }

  // A profile by handle. For a TEAMMATE (a viewer sharing a workspace, or the
  // person themselves) it's the full card: work count, GitHub link, follow state.
  // For anyone else it's an identity card — enough for an author chip to resolve
  // (name/handle/avatar/role/bio), no work, no graph. There is no public follower
  // count or global work grid at launch; the profile is who-you-work-with
  // infrastructure, not a broadcast surface. Email is never returned.
  app.get("/v1/users/:handle", async (c) => {
    const handle = normalizeUsername(c.req.param("handle"))
    const p = await meta.getUserByUsername(handle)
    if (!p) return fail(c, 404, "no profile with that username")
    if (!(await profileVisibleTo(c, p))) return fail(c, 404, "no profile with that username")
    const me = await currentUser(c)
    // sharedOrgIds(x, x) is all of x's workspaces — self is trivially a teammate.
    const sharedOrgs = me ? await meta.sharedOrgIds(me.id, p.id) : []
    const teammate = !!me && (me.id === p.id || sharedOrgs.length > 0)
    const ghIds = await meta.githubIdsForUser(p.id)
    const [works, githubLogin] = await Promise.all([
      teammate ? meta.countUserWorks(p.id, ghIds, { visibleOrgIds: sharedOrgs }) : 0,
      meta.githubLoginForUser(p.id, ghIds),
    ])
    // Already following? People-follows are global, so listFollows (which folds in the
    // org "*" rows) carries them regardless of the viewer's active workspace.
    let followedByMe = false
    if (me && me.id !== p.id) {
      const mine = await meta.listFollows(me.id, await activeWorkspace(c))
      followedByMe = mine.some((f) => f.kind === "user" && f.target === p.id)
    }
    return c.json({
      user: {
        username: p.username,
        name: p.name,
        image: p.image,
        profession: p.profession ?? null,
        about: p.about ?? null,
        github_login: githubLogin,
        teammate,
        ...(teammate ? { stats: { works } } : {}),
        followed_by_me: followedByMe,
      },
    })
  })

  // A person's work — for TEAMMATES (and the person themselves): the artifacts
  // they've authored, newest first, keyset-paginated (?cursor=<created_at>|<id>&limit=N),
  // visibility-gated IN SQL to the workspaces the viewer shares. Anyone else gets
  // an empty page — a profile is not a broadcast surface at launch, so there is
  // no public work grid to crawl.
  app.get("/v1/users/:handle/artifacts", async (c) => {
    const p = await meta.getUserByUsername(normalizeUsername(c.req.param("handle")))
    if (!p) return fail(c, 404, "no profile with that username")
    if (!(await profileVisibleTo(c, p))) return fail(c, 404, "no profile with that username")
    const me = await currentUser(c)
    // sharedOrgIds(x, x) is all of x's workspaces — self always sees their own work.
    const sharedOrgs = me ? await meta.sharedOrgIds(me.id, p.id) : []
    if (!me || (me.id !== p.id && sharedOrgs.length === 0))
      return c.json({ artifacts: [], next_cursor: null })
    const ghIds = await meta.githubIdsForUser(p.id)
    const limit = Math.min(50, Math.max(1, Number(c.req.query("limit")) || 24))
    const rawCursor = c.req.query("cursor")
    const sep = rawCursor?.indexOf("|") ?? -1
    const cursor =
      rawCursor && sep > 0
        ? { created_at: rawCursor.slice(0, sep), id: rawCursor.slice(sep + 1) }
        : undefined
    const rows = await meta.listUserWorks(p.id, ghIds, {
      limit: limit + 1,
      cursor,
      visibleOrgIds: sharedOrgs,
    })
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page[page.length - 1]
    const next_cursor = hasMore && last ? `${last.created_at}|${last.id}` : null
    const pageIds = page.map((a) => a.id)
    const counts = analyticsOn ? await meta.viewCounts(pageIds) : {}
    const tags = await meta.tagsForArtifacts(pageIds)
    const handleByGhId = await resolveHandles(meta, [
      ...new Set(page.map((a) => a.author_gh_id).filter((x): x is string => !!x)),
    ])
    return c.json({
      artifacts: page.map((a) => ({
        ...toJson(deps.baseUrl, a, []),
        views: counts[a.id] ?? 0,
        tags: tags[a.id] ?? [],
        author: authorProfile(a, handleByGhId),
      })),
      next_cursor,
    })
  })

  // (The followers/following list routes were removed with the launch social
  // cut — the follow graph is workspace work-awareness now, not a browsable
  // surface. They return with the social layer if that bet is ever taken.)

  // Upload your profile picture. We take only raster images (identified by their
  // magic bytes, not the client content-type) and store them content-addressed in
  // the blob store, pointing `user.image` at the served URL. Signed-in only (the
  // anon write-lockdown already blocks unauthenticated POSTs).
  app.post("/v1/me/avatar", async (c) => {
    const u = await requireUser(c)
    if (u instanceof Response) return u
    const len = Number(c.req.header("content-length") ?? 0)
    if (len > MAX_AVATAR_BYTES + 4096) return fail(c, 413, "image too large (max 2MB)")
    const body = await c.req.parseBody()
    const file = body.file
    if (!(file instanceof File)) return fail(c, 400, "multipart field 'file' required")
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (bytes.byteLength > MAX_AVATAR_BYTES) return fail(c, 413, "image too large (max 2MB)")
    // Trust the bytes, not the declared type — and reject anything that isn't a
    // plain raster image (no SVG: it could carry script served from our origin).
    if (!sniffImageType(bytes))
      return fail(c, 400, "unsupported image (use PNG, JPEG, GIF, or WebP)")
    const key = await blobs.put(bytes)
    // Absolute URL so it resolves from the API origin even when the SPA is served
    // from a separate origin (hosted split); the bytes never touch the app cookie.
    const image = `${deps.baseUrl.replace(/\/$/, "")}/v1/avatars/${key}`
    await meta.setUserImage(u.id, image)
    return c.json({ image })
  })

  // Serve an avatar blob. Public (avatars show on public profiles) and immutable
  // (the key is the content hash). Content-type is re-derived from the bytes, so
  // only the validated raster types we stored can ever come back out.
  app.get("/v1/avatars/:key", async (c) => {
    const bytes = await blobs.get(c.req.param("key"))
    if (!bytes) return fail(c, 404, "not found")
    const type = sniffImageType(bytes)
    if (!type) return fail(c, 404, "not found")
    return c.body(toBody(bytes), 200, { "Content-Type": type, "Cache-Control": IMMUTABLE_CACHE })
  })

  // Directory for the @mention picker — people AND agents, so an agent can be
  // @mentioned like anyone. Authenticated callers only (a signed-in user or the
  // static token); an anonymous visitor can never enumerate anyone. Optional ?query=
  // filters by name/email prefix.
  //
  // Scope: with ?artifact=<shortId> (and read access to it) the directory is the
  // people you can actually mention ON THAT THREAD — the artifact's workspace
  // members, anyone it's directly shared with, AND everyone who has commented on
  // it — even if they aren't in your active workspace (the @-a-collaborator case).
  // Without it, the caller's active-workspace members (composing outside a thread).
  app.get("/v1/users", async (c) => {
    const me = await currentUser(c)
    if (!me && !isToken(c)) return fail(c, 401, "unauthenticated")
    const q = (c.req.query("query") ?? "").trim().toLowerCase()

    const shortId = c.req.query("artifact")
    const found = shortId ? await meta.getByShortId(shortId) : null
    const artifact = found && (await authorize(c, "read", found)) ? found : null
    const org = artifact ? artifact.org_id : await activeWorkspace(c)

    const ids = new Set<string>()
    if (me) ids.add(me.id) // you can always @mention yourself
    // The full workspace roster is only for MEMBERS of that workspace — not a stranger
    // who can merely read one of its public artifacts. Without this, anyone could pull
    // an entire workspace's member list by passing any public artifact's short id.
    const isOrgMember = await isMember(c, org)
    if (isOrgMember) for (const m of await meta.listMemberships(org)) ids.add(m.user_id)
    // Thread participants (the artifact's members + people who've commented) are only
    // exposed to someone who can actually mention on the thread — i.e. has comment
    // access. A pure read-only viewer gets just themselves.
    if (
      artifact &&
      (isToken(c) || can(await actorFor(c, artifact), "comment", artifact.visibility))
    ) {
      for (const m of await meta.listArtifactMembers(artifact.id)) ids.add(m.user_id)
      for (const cm of await meta.listComments(artifact.id)) if (cm.author_id) ids.add(cm.author_id)
    }

    const users = await meta.getUsers([...ids])
    // The picker identifies people by @handle + display name — never email. The
    // email is still matchable server-side (q) so you can find someone you know by
    // their address, but it is never returned.
    const people = (
      q
        ? users.filter(
            (u) =>
              (u.name ?? "").toLowerCase().includes(q) ||
              (u.username ?? "").includes(q) ||
              u.email.toLowerCase().includes(q),
          )
        : users
    ).map((u) => ({
      id: u.id,
      handle: u.username,
      name: u.name,
      kind: "user" as const,
      // Role rides the directory so the @mention picker (and agents reading it)
      // know who's who; the bio is reserved for the full profile, not this list.
      profession: u.profession ?? null,
    }))
    const agents = (await meta.listAgents(org))
      .filter((ag) => !q || ag.name.toLowerCase().includes(q))
      .map((ag) => ({
        id: ag.id,
        handle: null,
        name: ag.name,
        kind: "agent" as const,
        profession: null,
      }))
    const all = [...people, ...agents].sort((a, b) =>
      (a.name ?? a.handle ?? "").localeCompare(b.name ?? b.handle ?? ""),
    )
    return c.json({ users: all })
  })

  return app
}

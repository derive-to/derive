import { can, normalizeUsername, usernameError } from "@dock/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { safeEqual } from "../lib/crypto"
import { fail, IMMUTABLE_CACHE, readJson, toBody } from "../lib/http"
import { MAX_AVATAR_BYTES, sniffImageType } from "../lib/image"

/** Session identity + the workspace member/agent directory for the @mention picker. */
export const sessionRoutes = (ctx: AppContext) => {
  const {
    meta,
    blobs,
    deps,
    bearer,
    currentUser,
    ensureMembership,
    activeWorkspace,
    authorize,
    actorFor,
  } = ctx
  const app = new Hono()

  app.get("/v1/me", async (c) => {
    const u = await currentUser(c)
    if (!u) return fail(c, 401, "unauthenticated")
    const role = await ensureMembership(await activeWorkspace(c), u.id) // provisions on first load
    return c.json({ user: { ...u, role }, multi: true })
  })

  // Claim or change your handle (Profiles & Accounts v1) — the prompt shown at
  // onboarding, and re-runnable to rename later. Server-validated (shape +
  // reserved words) and lowercased before storage; a clash with another account
  // is a 409. Only the signed-in user can set their own (the anon-write lockdown
  // already blocks unauthenticated POSTs).
  app.post("/v1/me/username", async (c) => {
    const u = await currentUser(c)
    if (!u) return fail(c, 401, "unauthenticated")
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
    const u = await currentUser(c)
    if (!u) return fail(c, 401, "unauthenticated")
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

  // Opt in/out of people search. Off by default, so you're only findable by
  // username if you choose to be (signed-in user sets their own).
  app.post("/v1/me/discoverable", async (c) => {
    const u = await currentUser(c)
    if (!u) return fail(c, 401, "unauthenticated")
    const body = await readJson(c, z.object({ discoverable: z.boolean() }))
    if (body instanceof Response) return body
    await meta.setUserDiscoverable(u.id, body.discoverable)
    return c.json({ discoverable: body.discoverable })
  })

  // People search: find OPTED-IN accounts by handle or name (GitHub-style "add by
  // username"). Only users who turned on discoverability appear, and only the
  // public fields (handle, name, avatar) come back — never email. Signed-in only,
  // and an empty query returns nothing, so it can't be used to enumerate everyone.
  // Registered before /v1/users/:handle so "search" isn't read as a handle.
  app.get("/v1/users/search", async (c) => {
    if (!(await currentUser(c))) return fail(c, 401, "unauthenticated")
    const q = (c.req.query("q") ?? "").trim()
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

  // A public profile by handle — the GitHub-style discovery surface. Email is
  // intentionally omitted (private); the handle, name, and avatar are public, so
  // this is readable by anyone (the GET passes the anon lockdown).
  app.get("/v1/users/:handle", async (c) => {
    const handle = normalizeUsername(c.req.param("handle"))
    const p = await meta.getUserByUsername(handle)
    if (!p) return fail(c, 404, "no profile with that username")
    return c.json({
      user: {
        username: p.username,
        name: p.name,
        image: p.image,
        profession: p.profession ?? null,
        about: p.about ?? null,
      },
    })
  })

  // Upload your profile picture. We take only raster images (identified by their
  // magic bytes, not the client content-type) and store them content-addressed in
  // the blob store, pointing `user.image` at the served URL. Signed-in only (the
  // anon write-lockdown already blocks unauthenticated POSTs).
  app.post("/v1/me/avatar", async (c) => {
    const u = await currentUser(c)
    if (!u) return fail(c, 401, "unauthenticated")
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
  // static token); an anonymous visitor can never enumerate anyone. Optional ?q=
  // filters by name/email prefix.
  //
  // Scope: with ?artifact=<shortId> (and read access to it) the directory is the
  // people you can actually mention ON THAT THREAD — the artifact's workspace
  // members, anyone it's directly shared with, AND everyone who has commented on
  // it — even if they aren't in your active workspace (the @-a-collaborator case).
  // Without it, the caller's active-workspace members (composing outside a thread).
  app.get("/v1/users", async (c) => {
    const me = await currentUser(c)
    const isToken = safeEqual(bearer(c), deps.token)
    if (!me && !isToken) return fail(c, 401, "unauthenticated")
    const q = (c.req.query("q") ?? "").trim().toLowerCase()

    const shortId = c.req.query("artifact")
    const found = shortId ? await meta.getByShortId(shortId) : null
    const artifact = found && (await authorize(c, "read", found)) ? found : null
    const org = artifact ? artifact.org_id : await activeWorkspace(c)

    const ids = new Set<string>()
    if (me) ids.add(me.id) // you can always @mention yourself
    // The full workspace roster is only for MEMBERS of that workspace — not a stranger
    // who can merely read one of its public artifacts. Without this, anyone could pull
    // an entire workspace's member list by passing any public artifact's short id.
    const isOrgMember = isToken || (!!me && !!(await meta.getMembership(org, me.id)))
    if (isOrgMember) for (const m of await meta.listMemberships(org)) ids.add(m.user_id)
    // Thread participants (the artifact's members + people who've commented) are only
    // exposed to someone who can actually mention on the thread — i.e. has comment
    // access. A pure read-only viewer gets just themselves.
    if (artifact && (isToken || can(await actorFor(c, artifact), "comment", artifact.visibility))) {
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

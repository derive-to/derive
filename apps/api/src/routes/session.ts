import { normalizeUsername, usernameError } from "@dock/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { safeEqual } from "../lib/crypto"
import { fail, readJson } from "../lib/http"

/** Session identity + the workspace member/agent directory for the @mention picker. */
export const sessionRoutes = (ctx: AppContext) => {
  const { meta, deps, bearer, currentUser, ensureMembership, activeWorkspace, authorize } = ctx
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

  // A public profile by handle — the GitHub-style discovery surface. Email is
  // intentionally omitted (private); the handle, name, and avatar are public, so
  // this is readable by anyone (the GET passes the anon lockdown).
  app.get("/v1/users/:handle", async (c) => {
    const handle = normalizeUsername(c.req.param("handle"))
    const p = await meta.getUserByUsername(handle)
    if (!p) return fail(c, 404, "no profile with that username")
    return c.json({ user: { username: p.username, name: p.name, image: p.image } })
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
    if (!(await currentUser(c)) && !safeEqual(bearer(c), deps.token))
      return fail(c, 401, "unauthenticated")
    const q = (c.req.query("q") ?? "").trim().toLowerCase()

    // Resolve the directory's org + the set of user ids in scope.
    const shortId = c.req.query("artifact")
    const found = shortId ? await meta.getByShortId(shortId) : null
    const artifact = found && (await authorize(c, "read", found)) ? found : null
    const org = artifact ? artifact.org_id : await activeWorkspace(c)
    const ids = new Set<string>((await meta.listMemberships(org)).map((m) => m.user_id))
    if (artifact) {
      for (const m of await meta.listArtifactMembers(artifact.id)) ids.add(m.user_id)
      for (const cm of await meta.listComments(artifact.id)) if (cm.author_id) ids.add(cm.author_id)
    }
    const users = await meta.getUsers([...ids])
    const people = (
      q
        ? users.filter(
            (u) => (u.name ?? "").toLowerCase().includes(q) || u.email.toLowerCase().includes(q),
          )
        : users
    ).map((u) => ({ id: u.id, name: u.name ?? u.email, email: u.email, kind: "user" as const }))
    const agents = (await meta.listAgents(org))
      .filter((ag) => !q || ag.name.toLowerCase().includes(q))
      .map((ag) => ({ id: ag.id, name: ag.name, email: "", kind: "agent" as const }))
    const all = [...people, ...agents].sort((a, b) => a.name.localeCompare(b.name))
    return c.json({ users: all })
  })

  return app
}

import { Hono } from "hono"
import type { AppContext } from "../context"
import { safeEqual } from "../lib/crypto"
import { fail } from "../lib/http"

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

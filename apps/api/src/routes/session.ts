import { Hono } from "hono"
import type { AppContext } from "../context"
import { safeEqual } from "../lib/crypto"
import { fail } from "../lib/http"

/** Session identity + the workspace member/agent directory for the @mention picker. */
export const sessionRoutes = (ctx: AppContext) => {
  const { meta, deps, open, bearer, currentUser, ensureMembership, activeWorkspace } = ctx
  const app = new Hono()

  app.get("/v1/me", async (c) => {
    const u = await currentUser(c)
    if (!u) return fail(c, 401, "unauthenticated")
    const role = await ensureMembership(await activeWorkspace(c), u.id) // provisions on first load
    return c.json({ user: { ...u, role }, multi: true })
  })

  // Workspace member directory for the @mention picker — people AND agents, so
  // an agent can be @mentioned like anyone. Signed-in (or open) only; optional
  // ?q= filters by name/email prefix. Never exposes non-members.
  app.get("/v1/users", async (c) => {
    if (!open && !(await currentUser(c)) && !safeEqual(bearer(c), deps.token))
      return fail(c, 401, "unauthenticated")
    const org = await activeWorkspace(c)
    const members = await meta.listMemberships(org)
    const users = await meta.getUsers(members.map((m) => m.user_id))
    const q = (c.req.query("q") ?? "").trim().toLowerCase()
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

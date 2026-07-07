import { randomUUID } from "node:crypto"
import { type InvitationRecord, newId, type Role } from "@derive/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { sha256 } from "../lib/crypto"
import { buildInviteEmail } from "../lib/email"
import { DEFAULT_WORKSPACE_NAME, fail, isWorkspaceRole, readJson } from "../lib/http"
import { resolveUserRef } from "../lib/resolve-user"
import { enqueueChannelDelivery } from "../webhooks"

// A plausible email (loose check — the real gate is deliverability). Anything without a
// single @ and a dotted domain is treated as a bad ref, not an invite.
const looksLikeEmail = (s: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/** The workspace itself: name + members (Admin-managed), plus multi-workspace
 *  list / create / switch. A workspace always keeps at least one Admin. */
export const workspaceRoutes = (ctx: AppContext) => {
  const {
    meta,
    deps,
    requireUser,
    currentUser,
    activeWorkspace,
    setWsCookie,
    workspaceRole,
    workspaceCan,
  } = ctx
  const { privateOwnerId } = ctx
  const app = new Hono()

  // A pending invite, minus the secret token (never leaves the server).
  const inviteJson = (i: InvitationRecord) => ({
    id: i.id,
    email: i.email,
    role: i.role,
    created_at: i.created_at,
    expires_at: i.expires_at,
  })

  // A workspace must always keep at least one Admin, so it stays manageable:
  // demoting or removing the last owner is refused.
  const isLastOwner = async (orgId: string, userId: string): Promise<boolean> => {
    const owners = (await meta.listMemberships(orgId)).filter((m) => m.role === "owner")
    return owners.length <= 1 && owners.some((m) => m.user_id === userId)
  }

  const memberJson = (
    m: { user_id: string; role: Role },
    dir: Map<string, { username: string | null; name: string | null; profession?: string | null }>,
  ) => ({
    user_id: m.user_id,
    handle: dir.get(m.user_id)?.username ?? null,
    name: dir.get(m.user_id)?.name ?? null,
    profession: dir.get(m.user_id)?.profession ?? null,
    role: m.role,
  })

  // The workspace name, the caller's role, and the full member directory.
  app.get("/v1/workspace", async (c) => {
    const role = await workspaceRole(c)
    if (role === null) return fail(c, 401, "unauthenticated")
    const org = await activeWorkspace(c)
    const [ws, members] = await Promise.all([meta.getWorkspace(org), meta.listMemberships(org)])
    const users = await meta.getUsers(members.map((m) => m.user_id))
    const dir = new Map(users.map((u) => [u.id, u]))
    return c.json({
      id: org,
      name: ws?.name ?? DEFAULT_WORKSPACE_NAME,
      role,
      multi: true,
      members: members.map((m) => memberJson(m, dir)),
    })
  })

  // Rename the workspace (Admin only).
  app.patch("/v1/workspace", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const b = await readJson(
      c,
      z.object({ name: z.string().refine((s) => s.trim() !== "", "name required") }),
    )
    if (b instanceof Response) return b
    const name = b.name.trim().slice(0, 80)
    const ws = await meta.setWorkspace(await activeWorkspace(c), name)
    return c.json({ name: ws.name })
  })

  // Add a member by email, or update their role (Admin only).
  app.put("/v1/workspace/members", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const b = await readJson(
      c,
      z
        .object({
          user: z.string().min(1).optional(),
          email: z.string().min(1).optional(),
          role: z.custom<Role>(isWorkspaceRole, "a valid role is required"),
        })
        .refine((v) => v.user || v.email, "a username or email is required"),
    )
    if (b instanceof Response) return b
    const id = await resolveUserRef(meta, (b.user ?? b.email) as string)
    const [user] = id ? await meta.getUsers([id]) : []
    if (!user) return fail(c, 404, "no Derive user with that username or email")
    const org = await activeWorkspace(c)
    // This route both adds and re-roles, so it must honor the same last-Admin
    // guard as PATCH — otherwise an Admin could demote the sole Admin via PUT.
    const existing = await meta.getMembership(org, user.id)
    if (existing?.role === "owner" && b.role !== "owner" && (await isLastOwner(org, user.id)))
      return fail(c, 409, "the workspace needs at least one admin")
    await meta.setMembership({
      id: existing?.id ?? newId("m"),
      org_id: org,
      user_id: user.id,
      role: b.role,
    })
    return c.json(
      {
        user_id: user.id,
        handle: user.username,
        name: user.name,
        profession: user.profession ?? null,
        role: b.role,
      },
      201,
    )
  })

  // Change a member's role (Admin only; can't strip the last Admin).
  app.patch("/v1/workspace/members/:userId", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const userId = c.req.param("userId")
    const b = await readJson(
      c,
      z.object({ role: z.custom<Role>(isWorkspaceRole, "a valid role is required") }),
    )
    if (b instanceof Response) return b
    const org = await activeWorkspace(c)
    const existing = await meta.getMembership(org, userId)
    if (!existing) return fail(c, 404, "not a member")
    if (existing.role === "owner" && b.role !== "owner" && (await isLastOwner(org, userId)))
      return fail(c, 409, "the workspace needs at least one admin")
    await meta.setMembership({ id: existing.id, org_id: org, user_id: userId, role: b.role })
    return c.json({ user_id: userId, role: b.role })
  })

  // Remove a member (Admin only; can't remove the last Admin).
  app.delete("/v1/workspace/members/:userId", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const userId = c.req.param("userId")
    const org = await activeWorkspace(c)
    const existing = await meta.getMembership(org, userId)
    if (!existing) return c.body(null, 204)
    if (existing.role === "owner" && (await isLastOwner(org, userId)))
      return fail(c, 409, "the workspace needs at least one admin")
    await meta.removeMembership(org, userId)
    return c.body(null, 204)
  })

  // ---- Invitations (bring in someone by email, incl. non-users) -----------
  // The one "add a person" action (Admin only): if the ref resolves to an existing
  // Derive account (by @handle or email) they're added straight to the roster; an
  // unknown email becomes a pending, emailed invitation redeemable via a token link.
  // The accept URL is always returned (so a mail-less self-host can copy the link),
  // and also emailed when a transport is configured.
  app.post("/v1/workspace/invites", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const b = await readJson(
      c,
      z.object({
        email: z.string().min(1),
        role: z.custom<Role>(isWorkspaceRole, "a valid role is required"),
      }),
    )
    if (b instanceof Response) return b
    const org = await activeWorkspace(c)
    const ref = b.email.trim()

    // Existing account → add directly (and clear any stale pending invite for them).
    const existingId = await resolveUserRef(meta, ref)
    if (existingId) {
      const [user] = await meta.getUsers([existingId])
      if (!user) return fail(c, 404, "no Derive user with that username or email")
      await meta.setMembership({
        id: (await meta.getMembership(org, existingId))?.id ?? newId("m"),
        org_id: org,
        user_id: existingId,
        role: b.role,
      })
      if (user.email) await meta.deletePendingInvitationsFor(org, user.email.toLowerCase())
      return c.json(
        {
          kind: "member" as const,
          member: {
            user_id: user.id,
            handle: user.username,
            name: user.name,
            profession: user.profession ?? null,
            role: b.role,
          },
        },
        201,
      )
    }

    // Otherwise it must look like an email — an unknown @handle is just a miss.
    const email = ref.toLowerCase()
    if (!looksLikeEmail(email)) return fail(c, 404, "no Derive user with that username or email")

    // A fresh token supersedes any prior pending invite for this email.
    await meta.deletePendingInvitationsFor(org, email)
    const token = `dki_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`
    const me = await currentUser(c)
    const invite = await meta.createInvitation({
      id: newId("inv"),
      org_id: org,
      email,
      role: b.role,
      token: sha256(token),
      invited_by: me?.id ?? null,
      expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    })
    const acceptUrl = `${deps.baseUrl.replace(/\/$/, "")}/invite/${token}`
    // Best-effort email through the retrying outbox; the returned link is the fallback
    // (and the primary channel on a self-host with no mail transport).
    const ws = await meta.getWorkspace(org)
    await enqueueChannelDelivery(
      meta,
      "email",
      "workspace.invite",
      buildInviteEmail({
        to: email,
        workspace: ws?.name ?? DEFAULT_WORKSPACE_NAME,
        inviter: me?.name ?? null,
        url: acceptUrl,
      }),
    )
    return c.json(
      { kind: "invite" as const, invite: inviteJson(invite), accept_url: acceptUrl },
      201,
    )
  })

  // Pending invitations for the workspace (Admin only). Tokens are never included.
  app.get("/v1/workspace/invites", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const invites = await meta.listPendingInvitations(await activeWorkspace(c))
    return c.json({ invites: invites.map(inviteJson) })
  })

  // Revoke a pending invitation (Admin only; scoped to the workspace).
  app.delete("/v1/workspace/invites/:id", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    await meta.deleteInvitation(c.req.param("id"), await activeWorkspace(c))
    return c.body(null, 204)
  })

  // Preview an invite before accepting — the accept page reads this to show the
  // workspace + role. The token IS the secret (possession authorizes), mirroring the
  // password-artifact model, so this is readable by anyone holding a valid, live token.
  app.get("/v1/invites/:token", async (c) => {
    const inv = await meta.getInvitationByToken(sha256(c.req.param("token")))
    if (!inv || inv.accepted_at || new Date(inv.expires_at).getTime() < Date.now())
      return fail(c, 404, "this invitation is invalid or has expired")
    const ws = await meta.getWorkspace(inv.org_id)
    const inviter = inv.invited_by ? (await meta.getUsers([inv.invited_by]))[0] : undefined
    return c.json({
      workspace: ws?.name ?? DEFAULT_WORKSPACE_NAME,
      role: inv.role,
      email: inv.email,
      inviter: inviter?.name ?? null,
    })
  })

  // Accept an invitation: the signed-in holder of the token joins the workspace at the
  // invited role (no-op if already a member), and the invite is marked spent.
  app.post("/v1/invites/:token/accept", async (c) => {
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const inv = await meta.getInvitationByToken(sha256(c.req.param("token")))
    if (!inv || inv.accepted_at || new Date(inv.expires_at).getTime() < Date.now())
      return fail(c, 404, "this invitation is invalid or has expired")
    // Possession still authorizes (self-hosts without email verification must keep
    // working), but a mismatched account is SURFACED, not silently joined: the
    // holder must explicitly confirm they meant to accept under this identity.
    // The web accept page pre-warns from the preview and sends the confirm with
    // the click; the machine-readable 409 is for headless callers.
    if (inv.email && inv.email.toLowerCase() !== me.email.toLowerCase()) {
      const b = await readJson(c, z.object({ confirm_mismatch: z.boolean().optional() }))
      // A malformed/absent body counts as "not confirmed", not a 400 — the 409
      // carries the flow either way.
      const confirmed = !(b instanceof Response) && b.confirm_mismatch === true
      if (!confirmed) return fail(c, 409, "email_mismatch", { invited_email: inv.email })
    }
    const existing = await meta.getMembership(inv.org_id, me.id)
    if (!existing)
      await meta.setMembership({
        id: newId("m"),
        org_id: inv.org_id,
        user_id: me.id,
        role: inv.role,
      })
    await meta.markInvitationAccepted(inv.id)
    return c.json({ org_id: inv.org_id, role: existing?.role ?? inv.role })
  })

  // ---- Integration settings (enable/disable each channel) -----------------
  // The workspace's integration toggles (email / GitHub post + mirror / Slack).
  // Any member can read them; only an Admin can change them.
  app.get("/v1/workspace/settings", async (c) => {
    const role = await workspaceRole(c)
    if (role === null) return fail(c, 401, "unauthenticated")
    return c.json(await meta.getOrgSettings(await activeWorkspace(c)))
  })

  app.patch("/v1/workspace/settings", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const b = await readJson(
      c,
      z
        .object({
          emailNotifications: z.boolean(),
          githubPostComments: z.boolean(),
          githubMirrorComments: z.boolean(),
          githubPreviewLink: z.boolean(),
          slackPost: z.boolean(),
          defaultUnlistedRole: z.enum(["viewer", "commenter"]),
          // `password` is excluded: a default can't carry the password it needs.
          defaultAgentVisibility: z.enum(["unlisted", "private", "org", "link", "public"]),
        })
        .partial(),
    )
    if (b instanceof Response) return b
    const org = await activeWorkspace(c)
    // Merge over current (so a partial PATCH only flips the keys it sends).
    const next = { ...(await meta.getOrgSettings(org)), ...b }
    await meta.setOrgSettings(org, next)
    return c.json(next)
  })

  // ---- Workspaces: list / create / switch (multi-workspace) --------------
  // The caller's workspaces (just the one in single mode). `active` is the id of
  // the workspace this request resolved to.
  app.get("/v1/workspaces", async (c) => {
    const role = await workspaceRole(c)
    if (role === null) return fail(c, 401, "unauthenticated")
    const active = await activeWorkspace(c)
    const me = await currentUser(c)
    // `personal` marks the caller's auto-provisioned workspace (its id is
    // deterministic — ws_p_<userId>, see provisionPersonal) so clients can label
    // it "Personal" and pin it, instead of leaking "X's Workspace" plumbing.
    const wsJson = (w: { id: string; name: string; role: Role }, ownerId: string) => ({
      id: w.id,
      name: w.name,
      role: w.role,
      personal: w.id === `ws_p_${ownerId}`,
    })
    if (!me) {
      // An OAuth agent lists its granting user's workspaces — the discovery
      // surface for choosing an X-Derive-Workspace target. Registered workspace
      // agents (no granting user) still see only their own workspace. `account`
      // is the owner's own identity (id + handle, never email — surfaces
      // identify people by handle) — what a bearer-only client (the CLI, a
      // local MCP server) keys its per-account credential store by, since it
      // has no session to ask `/v1/me` with.
      const owner = await privateOwnerId(c)
      const [ownerUser] = owner ? await meta.getUsers([owner]) : []
      const account = owner
        ? { id: owner, handle: ownerUser?.username ?? null, name: ownerUser?.name ?? null }
        : null
      const mine = owner ? await meta.listWorkspaces(owner) : []
      if (owner && mine.length)
        return c.json({
          multi: true,
          active,
          account,
          workspaces: mine.map((w) => wsJson(w, owner)),
        })
      const ws = await meta.getWorkspace(active)
      return c.json({
        multi: true,
        active,
        account,
        workspaces: [
          { id: active, name: ws?.name ?? DEFAULT_WORKSPACE_NAME, role, personal: false },
        ],
      })
    }
    const mine = await meta.listWorkspaces(me.id)
    return c.json({
      multi: true,
      active,
      account: { id: me.id, handle: me.username ?? null, name: me.name ?? null },
      workspaces: mine.map((w) => wsJson(w, me.id)),
    })
  })

  // Create a workspace. The creator becomes its Admin and is switched in.
  app.post("/v1/workspaces", async (c) => {
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const b = await readJson(
      c,
      z.object({ name: z.string().refine((s) => s.trim() !== "", "name required") }),
    )
    if (b instanceof Response) return b
    const name = b.name.trim().slice(0, 80)
    const id = newId("ws")
    await meta.setWorkspace(id, name)
    await meta.setMembership({ id: newId("m"), org_id: id, user_id: me.id, role: "owner" })
    setWsCookie(c, id)
    return c.json({ id, name, role: "owner" }, 201)
  })

  // Switch the active workspace. Must be a member.
  app.post("/v1/workspace/switch", async (c) => {
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const b = await readJson(c, z.object({ id: z.string().optional() }))
    if (b instanceof Response) return b
    const id = b.id ?? ""
    if (!id || !(await meta.getMembership(id, me.id)))
      return fail(c, 403, "not a member of that workspace")
    setWsCookie(c, id)
    return c.json({ active: id })
  })

  // Delete a workspace you own. Guarded: Admin only, never your last workspace, and
  // it must be empty (no artifacts) — we don't cascade-delete content. If it was the
  // active workspace, switch to another one you own.
  app.delete("/v1/workspaces/:id", async (c) => {
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const id = c.req.param("id")
    const mem = await meta.getMembership(id, me.id)
    if (mem?.role !== "owner") return fail(c, 403, "only an admin can delete this workspace")
    const mine = await meta.listWorkspaces(me.id)
    if (mine.length <= 1) return fail(c, 409, "you need at least one workspace")
    if ((await meta.countArtifacts(id)) > 0)
      return fail(c, 409, "this workspace still has artifacts — delete or move them first")
    const wasActive = (await activeWorkspace(c)) === id
    await meta.deleteWorkspace(id)
    const next = mine.find((w) => w.id !== id)?.id ?? null
    if (wasActive && next) setWsCookie(c, next)
    return c.json({ deleted: id, active: wasActive ? next : null })
  })

  return app
}

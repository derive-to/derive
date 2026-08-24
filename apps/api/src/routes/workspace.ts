import {
  newId,
  parseRunMeta,
  type Role,
  type RunRecord,
  runCounter,
  runMetaString,
} from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { OrgSettings } from "../lib/boot-shapes"
import { mintToken, sha256 } from "../lib/crypto"
import { buildInviteEmail } from "../lib/email"
import { bail, DEFAULT_WORKSPACE_NAME, fail, isWorkspaceRole, readJson } from "../lib/http"
import {
  emailMismatch409,
  INVITE_TTL_MS,
  inviteJson,
  isLiveInvite,
  looksLikeEmail,
} from "../lib/invite"
import { resolveUserRef } from "../lib/resolve-user"
import { syncSeats } from "../lib/seats"
import { armInviteAdmission } from "../lib/signup-policy"
import { ArtifactMember, BrandprintSchema, roleEnum } from "../schemas"
import { enqueueChannelDelivery } from "../webhooks"

/** A run, plus the timeline an operator actually needs: where it is, how long each phase took,
 *  how many attempts it has cost, and — when it is still queued — WHY it hasn't started yet.
 *  All derived from the row and its meta blob; nothing new is stored. */
const withTimeline = (r: RunRecord) => {
  // Parsed through the shared reader, so "what a malformed blob means" is decided once (in
  // core) rather than re-guessed by every consumer of these bytes.
  const meta = parseRunMeta(r.meta)
  const started = r.started_at ? Date.parse(r.started_at) : null
  const finished = r.finished_at ? Date.parse(r.finished_at) : null
  const scheduled = r.scheduled_for ? Date.parse(r.scheduled_for) : null
  const retries = runCounter(meta, "retries")
  return {
    ...r,
    timeline: {
      /** Queued → waiting on its scheduled time, or on a free slot / budget headroom. */
      phase: r.status,
      /** For a queued run: it isn't due yet (a schedule, or a retry backoff). The commonest
       *  "why is nothing happening" answer, and one logs alone can't give. */
      waiting_until:
        r.status === "queued" && scheduled && scheduled > Date.now() ? r.scheduled_for : null,
      /** How long it sat before an executor claimed it, and how long the work itself took. */
      queued_ms: started ? started - Date.parse(r.created_at) : null,
      ran_ms: started && finished ? finished - started : null,
      /** Attempts already spent (0 = first try). Each one costs the initiator's model plan. */
      retries,
      /** What went wrong last time, for a run that is retrying or gave up. */
      last_error: runMetaString(meta, "last_error") ?? runMetaString(meta, "why"),
      /** How the work landed: published | answered | cancelled | lost. */
      outcome: runMetaString(meta, "outcome"),
      /** The artifacts this run wrote, in order. */
      writes: Array.isArray(meta.writes) ? meta.writes : [],
    },
  }
}

/** The workspace itself: name + members (Admin-managed), plus multi-workspace
 *  list / create / switch. A workspace always keeps at least one Admin. The Workspace /
 *  OrgSettings / Invite / … schemas are the single source for the web client's types;
 *  members reuse the shared ArtifactMember shape. */
export const workspaceRoutes = (ctx: AppContext) => {
  const {
    meta,
    deps,
    requireUser,
    currentUser,
    activeWorkspace,
    requireWorkspace,
    setWsCookie,
    workspaceRole,
    seatGrantGate,
    workspacesOf,
  } = ctx
  const { privateOwnerId, oauthGrant, inviteLimiter, limited } = ctx
  const billing = deps.billing
  const app = new OpenAPIHono<BlankEnv>()

  const WorkspaceSummary = z
    .object({
      id: z.string(),
      name: z.string(),
      role: roleEnum.describe("The caller's role in this workspace (owner = Admin)."),
      personal: z
        .boolean()
        .describe("True for the auto-provisioned personal workspace (id ws_p_<userId>)."),
    })
    .openapi("WorkspaceSummary")

  const AccountSummary = z
    .object({
      id: z.string(),
      handle: z.string().nullable().describe("The account's @handle; null if unclaimed."),
      name: z.string().nullable(),
    })
    .openapi("AccountSummary")

  const Workspace = z
    .object({
      id: z.string(),
      name: z.string(),
      role: roleEnum.describe("The caller's role in this workspace (owner = Admin)."),
      members: z.array(ArtifactMember),
    })
    .openapi("Workspace")

  const Invite = z
    .object({
      id: z.string(),
      email: z.string(),
      role: roleEnum.describe("The role the invitee will receive (owner = Admin)."),
      created_at: z.string(),
      expires_at: z.string().describe("When the invite expires (7-day TTL)."),
    })
    .openapi("Invite")

  const InvitePreview = z
    .object({
      workspace: z.string().describe("Name of the workspace this invite joins."),
      role: roleEnum.describe("The role this invite grants (owner = Admin)."),
      email: z.string().describe("The email address the invite was addressed to."),
      inviter: z.string().nullable().describe("The inviter's display name; null if unknown."),
    })
    .openapi("InvitePreview")

  const InviteResult = z
    .union([
      z.object({
        kind: z
          .literal("member")
          .describe("The invitee already had an account and was added directly."),
        member: ArtifactMember,
      }),
      z.object({
        kind: z
          .literal("invite")
          .describe("No account yet — a pending invite was created instead."),
        invite: Invite,
        accept_url: z.string().describe("The link the invitee follows to accept."),
      }),
    ])
    .openapi("InviteResult")

  const Workspaces = z
    .object({
      multi: z.boolean().describe("Whether multi-workspace mode is enabled."),
      active: z.string().describe("Id of the workspace this request resolved to."),
      account: AccountSummary.nullable().describe(
        "The owner's identity (id + handle); null for anonymous callers.",
      ),
      workspaces: z.array(WorkspaceSummary),
    })
    .openapi("Workspaces")

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
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/workspace",
      tags: ["Workspace"],
      summary: "The active workspace: name, the caller's role, and the member directory.",
      responses: {
        200: {
          description: "The workspace + its members.",
          content: { "application/json": { schema: Workspace.extend({ multi: z.boolean() }) } },
        },
      },
    }),
    async (c) => {
      const role = await workspaceRole(c)
      if (role === null) return bail(fail(c, 401, "unauthenticated"))
      const org = await activeWorkspace(c)
      // Three reads keyed on the same org, the last of them strictly after the others
      // because it needs the member ids the roster returns — and Promise.all does not
      // overlap them on the edge tier (one pg.Client per invocation serialises whatever is
      // queued on it). `workspaceWithMembers` answers all three in one statement where the
      // store can; the fallback below is the original code, unchanged.
      const combined = meta.workspaceWithMembers ? await meta.workspaceWithMembers(org) : null
      const [ws, members] = combined
        ? [combined.workspace, combined.members]
        : await Promise.all([meta.getWorkspace(org), meta.listMemberships(org)])
      const users = combined ? combined.users : await meta.getUsers(members.map((m) => m.user_id))
      const dir = new Map(users.map((u) => [u.id, u]))
      return c.json({
        id: org,
        name: ws?.name ?? DEFAULT_WORKSPACE_NAME,
        role,
        multi: true,
        members: members.map((m) => memberJson(m, dir)),
      })
    },
  )

  // Rename the workspace (Admin only).
  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/workspace",
      tags: ["Workspace"],
      summary: "Rename the workspace (Admin only).",
      responses: {
        200: {
          description: "The new name.",
          content: { "application/json": { schema: z.object({ name: z.string() }) } },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const b = await readJson(
        c,
        z.object({ name: z.string().refine((s) => s.trim() !== "", "name required") }),
      )
      if (b instanceof Response) return bail(b)
      const name = b.name.trim().slice(0, 80)
      const ws = await meta.setWorkspace(org, name)
      return c.json({ name: ws.name })
    },
  )

  // Add a member by email, or update their role (Admin only).
  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/workspace/members",
      tags: ["Workspace"],
      summary: "Add a member (by @handle or email) or change their role (Admin only).",
      responses: {
        201: {
          description: "The added/updated member.",
          content: { "application/json": { schema: ArtifactMember } },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
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
      if (b instanceof Response) return bail(b)
      const id = await resolveUserRef(meta, (b.user ?? b.email) as string)
      const [user] = id ? await meta.getUsers([id]) : []
      if (!user) return bail(fail(c, 404, "no Derive user with that username or email"))
      // This route both adds and re-roles, so it must honor the same last-Admin
      // guard as PATCH — otherwise an Admin could demote the sole Admin via PUT.
      const existing = await meta.getMembership(org, user.id)
      if (existing?.role === "owner" && b.role !== "owner" && (await isLastOwner(org, user.id)))
        return bail(fail(c, 409, "the workspace needs at least one admin"))
      const gated = await seatGrantGate(c, org, b.role, existing?.role)
      if (gated) return bail(gated)
      await meta.setMembership({
        id: existing?.id ?? newId("m"),
        org_id: org,
        user_id: user.id,
        role: b.role,
      })
      await syncSeats({ meta, billing }, org)
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
    },
  )

  // Change a member's role (Admin only; can't strip the last Admin).
  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/workspace/members/{userId}",
      tags: ["Workspace"],
      summary: "Change a member's role (Admin only; keeps at least one admin).",
      request: { params: z.object({ userId: z.string() }) },
      responses: {
        200: {
          description: "The member's new role.",
          content: {
            "application/json": { schema: z.object({ user_id: z.string(), role: roleEnum }) },
          },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const userId = c.req.param("userId")
      const b = await readJson(
        c,
        z.object({ role: z.custom<Role>(isWorkspaceRole, "a valid role is required") }),
      )
      if (b instanceof Response) return bail(b)
      const existing = await meta.getMembership(org, userId)
      if (!existing) return bail(fail(c, 404, "not a member"))
      if (existing.role === "owner" && b.role !== "owner" && (await isLastOwner(org, userId)))
        return bail(fail(c, 409, "the workspace needs at least one admin"))
      const gated = await seatGrantGate(c, org, b.role, existing.role)
      if (gated) return bail(gated)
      await meta.setMembership({ id: existing.id, org_id: org, user_id: userId, role: b.role })
      await syncSeats({ meta, billing }, org)
      return c.json({ user_id: userId, role: b.role })
    },
  )

  // Remove a member (Admin only; can't remove the last Admin).
  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/workspace/members/{userId}",
      tags: ["Workspace"],
      summary: "Remove a member (Admin only; keeps at least one admin).",
      request: { params: z.object({ userId: z.string() }) },
      responses: { 204: { description: "The member was removed (idempotent)." } },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const userId = c.req.param("userId")
      const existing = await meta.getMembership(org, userId)
      if (!existing) return c.body(null, 204)
      if (existing.role === "owner" && (await isLastOwner(org, userId)))
        return bail(fail(c, 409, "the workspace needs at least one admin"))
      const owned = await meta.workspaceOwnershipBlockers(org, userId)
      if (owned.artifacts > 0 || owned.collections > 0) {
        const resources = [
          owned.artifacts > 0
            ? `${owned.artifacts} artifact${owned.artifacts === 1 ? "" : "s"}`
            : null,
          owned.collections > 0
            ? `${owned.collections} collection${owned.collections === 1 ? "" : "s"}`
            : null,
        ].filter((resource) => resource !== null)
        return bail(
          fail(
            c,
            409,
            `Transfer or add another owner to ${resources.join(" and ")} before removing this member.`,
          ),
        )
      }
      await meta.removeMembership(org, userId)
      await syncSeats({ meta, billing }, org)
      return c.body(null, 204)
    },
  )

  // ---- Invitations (bring in someone by email, incl. non-users) -----------
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/workspace/invites",
      tags: ["Workspace"],
      summary: "Invite by email — adds an existing account directly, else a pending invite.",
      responses: {
        201: {
          description: "Either the member added directly, or the pending invite + accept link.",
          content: { "application/json": { schema: InviteResult } },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const b = await readJson(
        c,
        z.object({
          email: z.string().min(1),
          role: z.custom<Role>(isWorkspaceRole, "a valid role is required"),
        }),
      )
      if (b instanceof Response) return bail(b)
      const ref = b.email.trim()

      // Existing account → add directly (and clear any stale pending invite for them).
      const existingId = await resolveUserRef(meta, ref)
      // Hoisted so the gate covers BOTH branches below: a pending-email editor invite
      // would otherwise be accepted later into a seat the plan doesn't cover.
      const existingMembership = existingId ? await meta.getMembership(org, existingId) : null
      const gated = await seatGrantGate(c, org, b.role, existingMembership?.role)
      if (gated) return bail(gated)
      if (existingId) {
        const [user] = await meta.getUsers([existingId])
        if (!user) return bail(fail(c, 404, "no Derive user with that username or email"))
        await meta.setMembership({
          id: existingMembership?.id ?? newId("m"),
          org_id: org,
          user_id: existingId,
          role: b.role,
        })
        await syncSeats({ meta, billing }, org)
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
      if (!looksLikeEmail(email))
        return bail(fail(c, 404, "no Derive user with that username or email"))
      // Same cap as artifact invites: this branch emails an arbitrary address.
      const rl = await limited(c, inviteLimiter)
      if (rl) return bail(rl)

      // A fresh token supersedes any prior pending invite for this email.
      await meta.deletePendingInvitationsFor(org, email)
      const token = mintToken("dki")
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
      // Best-effort email through the retrying outbox; the returned link is the fallback.
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
    },
  )

  // Pending invitations for the workspace (Admin only). Tokens are never included.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/workspace/invites",
      tags: ["Workspace"],
      summary: "Pending invitations for the workspace (Admin only).",
      responses: {
        200: {
          description: "The pending invites (no tokens).",
          content: { "application/json": { schema: z.object({ invites: z.array(Invite) }) } },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const invites = await meta.listPendingInvitations(org)
      return c.json({ invites: invites.map(inviteJson) })
    },
  )

  // Rotate a pending invitation and return a fresh acceptance link. Tokens are never
  // stored in plaintext, so this is the safe recovery path after the original link is lost.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/workspace/invites/{id}/resend",
      tags: ["Workspace"],
      summary: "Rotate a pending invitation and return its acceptance link (Admin only).",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        201: {
          description: "The replacement pending invitation and acceptance link.",
          content: { "application/json": { schema: InviteResult } },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const invite = (await meta.listPendingInvitations(org)).find(
        (candidate) => candidate.id === c.req.param("id"),
      )
      if (!invite) return bail(fail(c, 404, "pending invitation not found"))
      const rl = await limited(c, inviteLimiter)
      if (rl) return bail(rl)

      await meta.deleteInvitation(invite.id, org)
      const token = mintToken("dki")
      const inviter = await currentUser(c)
      const replacement = await meta.createInvitation({
        id: newId("inv"),
        org_id: org,
        email: invite.email,
        role: invite.role,
        token: sha256(token),
        invited_by: inviter?.id ?? null,
        expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
      })
      const acceptUrl = `${deps.baseUrl.replace(/\/$/, "")}/invite/${token}`
      const ws = await meta.getWorkspace(org)
      await enqueueChannelDelivery(
        meta,
        "email",
        "workspace.invite",
        buildInviteEmail({
          to: invite.email,
          workspace: ws?.name ?? DEFAULT_WORKSPACE_NAME,
          inviter: inviter?.name ?? null,
          url: acceptUrl,
        }),
      )
      return c.json(
        { kind: "invite" as const, invite: inviteJson(replacement), accept_url: acceptUrl },
        201,
      )
    },
  )

  // Revoke a pending invitation (Admin only; scoped to the workspace).
  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/workspace/invites/{id}",
      tags: ["Workspace"],
      summary: "Revoke a pending invitation (Admin only).",
      request: { params: z.object({ id: z.string() }) },
      responses: { 204: { description: "The invitation was revoked." } },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      await meta.deleteInvitation(c.req.param("id"), org)
      return c.body(null, 204)
    },
  )

  // Preview an invite before accepting — the token IS the secret (possession authorizes).
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/invites/{token}",
      tags: ["Workspace"],
      summary: "Preview an invitation (the accept page reads this).",
      request: { params: z.object({ token: z.string() }) },
      responses: {
        200: {
          description: "The workspace + role the token grants.",
          content: { "application/json": { schema: InvitePreview } },
        },
      },
    }),
    async (c) => {
      const tokenHash = sha256(c.req.param("token"))
      const inv = await meta.getInvitationByToken(tokenHash)
      if (!inv || !isLiveInvite(inv))
        return bail(fail(c, 404, "this invitation is invalid or has expired"))
      await armInviteAdmission(c, "workspace", tokenHash, inv.expires_at, deps.encryptionKey, {
        baseUrl: deps.baseUrl,
        crossSite: deps.crossSite,
      })
      const ws = await meta.getWorkspace(inv.org_id)
      const inviter = inv.invited_by ? (await meta.getUsers([inv.invited_by]))[0] : undefined
      return c.json({
        workspace: ws?.name ?? DEFAULT_WORKSPACE_NAME,
        role: inv.role,
        email: inv.email,
        inviter: inviter?.name ?? null,
      })
    },
  )

  // Accept an invitation: the signed-in holder of the token joins the workspace.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/invites/{token}/accept",
      tags: ["Workspace"],
      summary: "Accept an invitation (the signed-in token holder joins).",
      request: { params: z.object({ token: z.string() }) },
      responses: {
        200: {
          description: "The workspace joined + the caller's effective role.",
          content: {
            "application/json": { schema: z.object({ org_id: z.string(), role: roleEnum }) },
          },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      const inv = await meta.getInvitationByToken(sha256(c.req.param("token")))
      if (!inv || !isLiveInvite(inv))
        return bail(fail(c, 404, "this invitation is invalid or has expired"))
      const mismatch = await emailMismatch409(c, inv.email, me.email)
      if (mismatch) return bail(mismatch)
      const now = new Date().toISOString()
      if (!(await meta.consumeInvitation(inv.id, now)))
        return bail(fail(c, 409, "this invitation has already been accepted"))
      const existing = await meta.getMembership(inv.org_id, me.id)
      if (!existing) {
        await meta.setMembership({
          id: newId("m"),
          org_id: inv.org_id,
          user_id: me.id,
          role: inv.role,
        })
        await syncSeats({ meta, billing }, inv.org_id)
      }
      return c.json({ org_id: inv.org_id, role: existing?.role ?? inv.role })
    },
  )

  // ---- Integration settings (enable/disable each channel) -----------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/workspace/settings",
      tags: ["Workspace"],
      summary: "The workspace's integration toggles (any member).",
      responses: {
        200: {
          description: "The workspace settings.",
          content: { "application/json": { schema: OrgSettings } },
        },
      },
    }),
    async (c) => {
      const role = await workspaceRole(c)
      if (role === null) return bail(fail(c, 401, "unauthenticated"))
      return c.json(await meta.getOrgSettings(await activeWorkspace(c)))
    },
  )

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/workspace/settings",
      tags: ["Workspace"],
      summary: "Update the workspace's integration toggles (Admin only).",
      responses: {
        200: {
          description: "The merged settings.",
          content: { "application/json": { schema: OrgSettings } },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const b = await readJson(
        c,
        z
          .object({
            emailNotifications: z.boolean(),
            defaultWorkspaceAccess: z.enum(["none", "member"]),
            defaultLinkRole: z.enum(["none", "viewer", "commenter", "editor"]),
            defaultListed: z.enum(["none", "workspace", "public"]),
            whiteLabel: z.boolean(),
            hostedAgentsEnabled: z.boolean(),
            chatBeta: z.boolean(),
            // Connection ids chat may reach. Admin-set, empty by default — see OrgSettings.
            chatSources: z.array(z.string()),
            automateBeta: z.boolean(),
            agentWrites: z.boolean(),
            defaultAgentId: z.string().nullable(),
            brandprint: BrandprintSchema.nullable(),
          })
          .partial(),
      )
      if (b instanceof Response) return bail(b)
      // Merge over current (so a partial PATCH only flips the keys it sends). Brandprint
      // is pulled out and merged one level deep below, so setting collectionId alone
      // doesn't wipe an existing profileId (and vice versa). defaultAgentId is pulled
      // out too: null clears it, and a set must name an agent in THIS workspace (the
      // store doesn't check ownership, so the route does — same rule as brandprint).
      const { brandprint, defaultAgentId, ...flat } = b
      const cur = await meta.getOrgSettings(org)
      const next = { ...cur, ...flat }
      if (defaultAgentId === null) next.defaultAgentId = undefined
      else if (defaultAgentId) {
        const agents = await meta.listAgents(org)
        if (!agents.some((a) => a.id === defaultAgentId))
          return bail(fail(c, 400, "default agent not found in this workspace"))
        next.defaultAgentId = defaultAgentId
      }
      if (brandprint === null) next.brandprint = undefined
      else if (brandprint) {
        // Both pointers must be owned by this workspace: an unvalidated id could point
        // at another tenant's collection (or make its artifact the headline MCP
        // resource) and leak bodies over MCP. The store doesn't check ownership, so
        // the route does. Clearing or a partial patch points at nothing new and skips
        // the lookups; the two checks are independent, so they run together.
        const [col, art] = await Promise.all([
          brandprint.collectionId ? meta.getCollection(brandprint.collectionId) : null,
          brandprint.profileId ? meta.getByShortId(brandprint.profileId) : null,
        ])
        if (brandprint.collectionId && (!col || col.org_id !== org))
          return bail(fail(c, 400, "brandprint collection not found in this workspace"))
        if (brandprint.profileId && (!art || art.org_id !== org))
          return bail(fail(c, 400, "brandprint profile not found in this workspace"))
        const m = { ...cur.brandprint, ...brandprint }
        next.brandprint = {
          collectionId: m.collectionId ?? undefined,
          profileId: m.profileId ?? undefined,
        }
      }
      // The default access must satisfy the same listing preconditions a publish
      // would (see access-model.md) — otherwise every new publish that takes the
      // defaults would 400. Validate the MERGED result, so a partial PATCH can't
      // leave the pair incoherent.
      if (next.defaultListed === "workspace" && next.defaultWorkspaceAccess !== "member")
        return bail(fail(c, 400, "a workspace-listed default needs default workspace access"))
      if (next.defaultListed === "public" && next.defaultLinkRole === "none")
        return bail(fail(c, 400, "a publicly-listed default needs a default link role"))
      await meta.setOrgSettings(org, next)
      return c.json(next)
    },
  )

  // ---- Workspaces: list / create / switch (multi-workspace) --------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/workspaces",
      tags: ["Workspace"],
      summary: "The caller's workspaces + which one this request resolved to.",
      responses: {
        200: {
          description: "The caller's workspaces and the active id.",
          content: { "application/json": { schema: Workspaces } },
        },
      },
    }),
    async (c) => {
      const role = await workspaceRole(c)
      if (role === null) return bail(fail(c, 401, "unauthenticated"))
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
        // surface for choosing an X-Derive-Workspace target. `account` is the
        // owner's identity (id + handle, never email) that a bearer-only client
        // (CLI / local MCP) keys its per-account credential store by.
        const owner = await privateOwnerId(c)
        const [ownerUser] = owner ? await meta.getUsers([owner]) : []
        const account = owner
          ? { id: owner, handle: ownerUser?.username ?? null, name: ownerUser?.name ?? null }
          : null
        // Restrict to the workspaces THIS grant is scoped to (the consent multi-
        // select); an empty scope = all. So a bearer client (the CLI, an MCP
        // connection) only discovers — and stores — the workspaces its grant covers.
        const all = owner ? await meta.listWorkspaces(owner) : []
        const grant = await oauthGrant(c)
        const bound = grant?.boundWorkspaces ?? []
        const mine = bound.length ? all.filter((w) => bound.includes(w.id)) : all
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
      // Memoized: activeWorkspace above may already have read this exact list.
      const mine = await workspacesOf(c, me.id)
      return c.json({
        multi: true,
        active,
        account: { id: me.id, handle: me.username ?? null, name: me.name ?? null },
        workspaces: mine.map((w) => wsJson(w, me.id)),
      })
    },
  )

  // Create a workspace. The creator becomes its Admin and is switched in.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/workspaces",
      tags: ["Workspace"],
      summary: "Create a workspace (the creator becomes its Admin and is switched in).",
      responses: {
        201: {
          description: "The created workspace.",
          content: { "application/json": { schema: WorkspaceSummary } },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      const b = await readJson(
        c,
        z.object({ name: z.string().refine((s) => s.trim() !== "", "name required") }),
      )
      if (b instanceof Response) return bail(b)
      const name = b.name.trim().slice(0, 80)
      const id = newId("ws")
      await meta.setWorkspace(id, name)
      await meta.setMembership({ id: newId("m"), org_id: id, user_id: me.id, role: "owner" })
      setWsCookie(c, id)
      return c.json({ id, name, role: "owner" as const, personal: false }, 201)
    },
  )

  // Switch the active workspace. Must be a member.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/workspace/switch",
      tags: ["Workspace"],
      summary: "Switch the active workspace (must be a member).",
      responses: {
        200: {
          description: "The new active workspace id.",
          content: { "application/json": { schema: z.object({ active: z.string() }) } },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      const b = await readJson(c, z.object({ id: z.string().optional() }))
      if (b instanceof Response) return bail(b)
      const id = b.id ?? ""
      if (!id || !(await meta.getMembership(id, me.id)))
        return bail(fail(c, 403, "not a member of that workspace"))
      setWsCookie(c, id)
      return c.json({ active: id })
    },
  )

  // Delete a workspace you own. Admin only, never your last, and it must be empty.
  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/workspaces/{id}",
      tags: ["Workspace"],
      summary: "Delete an empty workspace you own (switches away if it was active).",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The deleted id + the new active workspace (or null).",
          content: {
            "application/json": {
              schema: z.object({ deleted: z.string(), active: z.string().nullable() }),
            },
          },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      const id = c.req.param("id")
      const mem = await meta.getMembership(id, me.id)
      if (mem?.role !== "owner")
        return bail(fail(c, 403, "only an admin can delete this workspace"))
      const mine = await meta.listWorkspaces(me.id)
      if (mine.length <= 1) return bail(fail(c, 409, "you need at least one workspace"))
      if ((await meta.countArtifacts(id)) > 0)
        return bail(fail(c, 409, "this workspace still has artifacts — delete or move them first"))
      const wasActive = (await activeWorkspace(c)) === id
      await meta.deleteWorkspace(id)
      const next = mine.find((w) => w.id !== id)?.id ?? null
      if (wasActive && next) setWsCookie(c, next)
      return c.json({ deleted: id, active: wasActive ? next : null })
    },
  )

  // The agent activity view: the workspace's recent runs, newest first — the ledger
  // half of the run table. Admin-only: it exposes what every agent did, why, and what it
  // cost. A plain route (not in the OpenAPI spec); the web activity page consumes it directly.
  app.get("/v1/workspace/runs", async (c) => {
    const org = await requireWorkspace(c, "manage")
    if (org instanceof Response) return org
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 50))
    const runs = await meta.listRuns(org, limit)
    // The run TIMELINE, derived rather than stored: the row already carries every timestamp and
    // the meta blob carries the outcome, the writes, the retry count, and the last error.
    // Surfacing it here lets an operator answer "why hasn't this run started, and what happened
    // to it" without reading server logs — the difference between a hosted executor being
    // correct and being operable.
    return c.json({ runs: runs.map(withTimeline) })
  })

  return app
}

import { randomUUID } from "node:crypto"
import {
  type ArtifactInviteRecord,
  type ArtifactRecord,
  effectiveRole,
  isRole,
  newId,
  ROLES,
  type Role,
} from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { sha256 } from "../lib/crypto"
import { buildArtifactInviteEmail, buildShareEmail } from "../lib/email"
import { bail, fail, readJson } from "../lib/http"
import { resolveUserRef } from "../lib/resolve-user"
import { enqueueSlackShareDm } from "../lib/slack-dm"
import { ArtifactMember } from "../schemas"
import { enqueueChannelDelivery } from "../webhooks"

/** Per-artifact role overrides (a share). Managing shares requires `share`
 *  (editor+, GDocs model); the share's role beats the caller's workspace baseline.
 *  Members are returned as the shared ArtifactMember shape (generated web type). */
export const sharingRoutes = (ctx: AppContext) => {
  const { meta, deps, defaultRole, authorize, actorFor, actingUser, requireUser, bus } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  // A sharer can never grant — or remove — a role above their own. An editor (who
  // has `share` but not `manage`) invites viewers/commenters/editors; only an owner
  // can grant owner. Without this, an editor could PUT themselves `owner` (which
  // confers `manage`) and DELETE the real owner, seizing the artifact.
  const rank = (r: Role | null): number => (r ? ROLES.indexOf(r) : -1)
  const callerRank = async (c: Context, a: ArtifactRecord): Promise<number> =>
    rank(effectiveRole(await actorFor(c, a), a.workspace_access, a.link_role))

  // ---- Per-artifact invites (share-by-email to someone with no account) ----
  const looksLikeEmail = (v: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)
  const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days, matching workspace invites

  const roleEnum = z.enum(["viewer", "commenter", "editor", "owner"])
  const ArtifactInvite = z
    .object({
      id: z.string(),
      email: z.string().describe("The invitee's email (share-capable callers only)."),
      role: roleEnum.describe("The role accepting will grant."),
      created_at: z.string(),
      expires_at: z.string().describe("When the invite expires (7-day TTL)."),
    })
    .openapi("ArtifactInvite")
  const ArtifactInvitePreview = z
    .object({
      title: z.string().nullable().describe("The artifact's title; null if untitled."),
      role: roleEnum.describe("The role this invite grants."),
      email: z.string().describe("The email address the invite was addressed to."),
      inviter: z.string().nullable().describe("The inviter's display name; null if unknown."),
    })
    .openapi("ArtifactInvitePreview")
  const ShareResult = z
    .union([
      z.object({
        kind: z.literal("member").describe("The person already had an account — shared directly."),
        member: ArtifactMember,
      }),
      z.object({
        kind: z
          .literal("invite")
          .describe("No account with that email — a pending invite was created and emailed."),
        invite: ArtifactInvite,
        accept_url: z.string().describe("The link the invitee follows to accept."),
      }),
    ])
    .openapi("ShareResult")
  // A pending invite, minus the secret token (never leaves the server).
  const inviteJson = (i: ArtifactInviteRecord) => ({
    id: i.id,
    email: i.email,
    role: i.role,
    created_at: i.created_at,
    expires_at: i.expires_at,
  })

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/artifacts/{shortId}/members",
      tags: ["Sharing"],
      summary: "List an artifact's collaborators (collaborators only).",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        200: {
          description: "The workspace default role and the artifact's members.",
          content: {
            "application/json": {
              schema: z.object({
                default_role: z
                  .enum(["viewer", "commenter", "editor", "owner"])
                  .describe("Workspace baseline role applied to anyone without an explicit share."),
                members: z
                  .array(ArtifactMember)
                  .describe("Collaborators with an explicit per-artifact role share."),
                invites: z
                  .array(ArtifactInvite)
                  .describe(
                    "Pending emailed invites — share-capable callers (editor+) only; empty otherwise (invitee emails stay need-to-know).",
                  ),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const artifact = await meta.getByShortId(c.req.param("shortId"))
      if (!artifact || !(await authorize(c, "read", artifact)))
        return bail(fail(c, 404, "not found"))
      // The member roster is for collaborators, not the public. A caller who only has
      // read access via the artifact's visibility (no membership and no share) gets
      // nothing — mirrors the collection-members gate, and stops a stranger reading a
      // public artifact's collaborator list cross-workspace. Identify members by their
      // public @handle; never expose email.
      const actor = await actorFor(c, artifact)
      const collaborator =
        actor.kind === "token" ||
        (actor.kind === "user" && (actor.orgRole != null || actor.artifactRole != null))
      if (!collaborator) return bail(fail(c, 404, "not found"))
      const rows = await meta.listArtifactMembers(artifact.id)
      const users = await meta.getUsers(rows.map((r) => r.user_id))
      const byId = new Map(users.map((u) => [u.id, u]))
      // Pending invites carry EMAILS, so they're need-to-know: only callers who can
      // themselves share (editor+) see them — a viewer-collaborator gets an empty list.
      const invites = (await authorize(c, "share", artifact))
        ? (await meta.listPendingArtifactInvites(artifact.id)).map(inviteJson)
        : []
      return c.json({
        default_role: defaultRole,
        members: rows.map((r) => ({
          user_id: r.user_id,
          handle: byId.get(r.user_id)?.username ?? null,
          name: byId.get(r.user_id)?.name ?? null,
          role: r.role,
        })),
        invites,
      })
    },
  )

  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/artifacts/{shortId}/members",
      tags: ["Sharing"],
      summary: "Share an artifact with a person at a role — or email an invite.",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        201: {
          description:
            "Either the member added directly (existing account), or the pending invite + accept link (unknown email).",
          content: { "application/json": { schema: ShareResult } },
        },
      },
    }),
    async (c) => {
      const artifact = await meta.getByShortId(c.req.param("shortId"))
      if (!artifact) return bail(fail(c, 404, "not found"))
      if (!(await authorize(c, "share", artifact))) return bail(fail(c, 403, "forbidden"))
      const b = await readJson(
        c,
        z
          .object({
            // Share by @username or by email — either resolves to the account.
            // `username` is accepted as an alias for `user` (both mean the @handle).
            user: z.string().min(1).optional(),
            username: z.string().min(1).optional(),
            email: z.string().min(1).optional(),
            role: z.custom<Role>(isRole, "a valid role is required"),
          })
          .refine((v) => v.user || v.username || v.email, "a username or email is required"),
      )
      if (b instanceof Response) return bail(b)
      if (rank(b.role) > (await callerRank(c, artifact)))
        return bail(fail(c, 403, "you can't grant a role above your own"))
      const ref = (b.user ?? b.username ?? b.email) as string
      const id = await resolveUserRef(meta, ref)
      const [user] = id ? await meta.getUsers([id]) : []
      if (!user) {
        // No account behind that ref. An email gets a pending invite (created here,
        // emailed, redeemed at signup — the share-a-doc growth loop); an unknown
        // @handle stays a plain miss.
        const email = ref.trim().toLowerCase()
        if (!looksLikeEmail(email))
          return bail(fail(c, 404, "no Derive user with that username or email"))
        // A fresh token supersedes any prior pending invite for this (artifact, email).
        await meta.deletePendingArtifactInvitesFor(artifact.id, email)
        const token = `dka_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`
        const sharer = await actingUser(c)
        const invite = await meta.createArtifactInvite({
          id: newId("ainv"),
          artifact_id: artifact.id,
          email,
          role: b.role,
          token: sha256(token),
          invited_by: sharer?.id ?? null,
          expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
        })
        const acceptUrl = `${deps.baseUrl.replace(/\/$/, "")}/invite/a/${token}`
        // Best-effort email through the retrying outbox; the returned link is the
        // fallback the dialog can copy.
        await enqueueChannelDelivery(
          meta,
          "email",
          "artifact.invite",
          buildArtifactInviteEmail({
            to: email,
            title: artifact.title ?? "an untitled artifact",
            inviter: sharer?.name ?? null,
            role: b.role,
            url: acceptUrl,
          }),
        )
        return c.json(
          { kind: "invite" as const, invite: inviteJson(invite), accept_url: acceptUrl },
          201,
        )
      }
      // A direct share supersedes any pending invite for the same person.
      if (user.email)
        await meta.deletePendingArtifactInvitesFor(artifact.id, user.email.toLowerCase())
      // An artifact keeps at least one owner-member: downgrading the sole owner
      // would orphan it — on `private` visibility, irrecoverably (workspace role
      // grants nothing there, so no one could share it back open).
      if (b.role !== "owner") {
        const members = await meta.listArtifactMembers(artifact.id)
        const owners = members.filter((m) => m.role === "owner")
        if (owners.length === 1 && owners[0]?.user_id === user.id)
          return bail(fail(c, 400, "an artifact keeps at least one owner"))
      }
      await meta.setArtifactMember({
        id: newId("am"),
        artifact_id: artifact.id,
        user_id: user.id,
        role: b.role,
      })
      // Notify the person you just shared with (bell + live stream), unless that's
      // you. A share has no comment thread, so the thread/comment ids are empty and
      // the bell deep-links straight to the artifact.
      const sharer = await actingUser(c)
      if (sharer && sharer.id !== user.id) {
        const row = {
          id: newId("n"),
          user_id: user.id,
          actor: sharer.name,
          kind: "share" as const,
          artifact_id: artifact.id,
          artifact_short_id: artifact.short_id,
          artifact_title: artifact.title,
          thread_id: "",
          comment_id: "",
          preview: `Shared with you as ${b.role}`,
        }
        await meta.createNotification(row)
        bus.publish(`u:${user.id}`, {
          type: "notification",
          notification: { ...row, read: 0, created_at: new Date().toISOString() },
        })
        // A share is deliberate and personal — it clears the email bar (the doc may
        // be the recipient's first contact with this workspace, so a bell alone can
        // sit unseen). Same workspace gate as the other notification emails.
        if (user.email && (await meta.getOrgSettings(artifact.org_id)).emailNotifications)
          await enqueueChannelDelivery(meta, "email", "artifact.shared", {
            to: user.email,
            toName: user.name ?? undefined,
            ...buildShareEmail(deps.baseUrl, artifact, {
              sharedBy: sharer.name ?? "Someone",
              role: b.role,
            }),
          })
        // Same interrupt, mirrored to Slack (independent of the email gate above —
        // gated on the recipient's own Slack-DM preference instead).
        await enqueueSlackShareDm(
          { meta, baseUrl: deps.baseUrl },
          artifact,
          { sharedBy: sharer.name ?? "Someone", role: b.role },
          user.id,
        )
      }
      // Echo the public handle, never the email — otherwise sharing by @handle would
      // be a handle→email oracle (resolve anyone's email by sharing an artifact with them).
      return c.json(
        {
          kind: "member" as const,
          member: { user_id: user.id, handle: user.username, name: user.name, role: b.role },
        },
        201,
      )
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/artifacts/{shortId}/members/{userId}",
      tags: ["Sharing"],
      summary: "Remove a collaborator from an artifact.",
      request: { params: z.object({ shortId: z.string(), userId: z.string() }) },
      responses: { 204: { description: "The collaborator was removed." } },
    }),
    async (c) => {
      const artifact = await meta.getByShortId(c.req.param("shortId"))
      if (!artifact) return bail(fail(c, 404, "not found"))
      if (!(await authorize(c, "share", artifact))) return bail(fail(c, 403, "forbidden"))
      const members = await meta.listArtifactMembers(artifact.id)
      const target = members.find((m) => m.user_id === c.req.param("userId"))
      if (target && rank(target.role) > (await callerRank(c, artifact)))
        return bail(fail(c, 403, "you can't remove a collaborator who outranks you"))
      // Same invariant as the role-change guard above: never remove the last owner.
      if (target?.role === "owner" && members.filter((m) => m.role === "owner").length === 1)
        return bail(fail(c, 400, "an artifact keeps at least one owner"))
      await meta.removeArtifactMember(artifact.id, c.req.param("userId"))
      return c.body(null, 204)
    },
  )

  // Revoke a pending invite (share-capable callers; can't revoke above your rank —
  // an editor can't kill an owner-invite, mirroring the member-removal guard).
  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/artifacts/{shortId}/invites/{id}",
      tags: ["Sharing"],
      summary: "Revoke a pending emailed invite.",
      request: { params: z.object({ shortId: z.string(), id: z.string() }) },
      responses: { 204: { description: "The invite was revoked." } },
    }),
    async (c) => {
      const artifact = await meta.getByShortId(c.req.param("shortId"))
      if (!artifact) return bail(fail(c, 404, "not found"))
      if (!(await authorize(c, "share", artifact))) return bail(fail(c, 403, "forbidden"))
      const target = (await meta.listPendingArtifactInvites(artifact.id)).find(
        (i) => i.id === c.req.param("id"),
      )
      if (target && rank(target.role) > (await callerRank(c, artifact)))
        return bail(fail(c, 403, "you can't revoke an invite that outranks you"))
      await meta.deleteArtifactInvite(c.req.param("id"), artifact.id)
      return c.body(null, 204)
    },
  )

  // Preview an invite before accepting — the token IS the secret (possession
  // authorizes), mirroring the workspace-invite preview.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/artifact-invites/{token}",
      tags: ["Sharing"],
      summary: "Preview an artifact invitation (the accept page reads this).",
      request: { params: z.object({ token: z.string() }) },
      responses: {
        200: {
          description: "The artifact + role the token grants.",
          content: { "application/json": { schema: ArtifactInvitePreview } },
        },
      },
    }),
    async (c) => {
      const inv = await meta.getArtifactInviteByToken(sha256(c.req.param("token")))
      if (!inv || inv.accepted_at || new Date(inv.expires_at).getTime() < Date.now())
        return bail(fail(c, 404, "this invitation is invalid or has expired"))
      const artifact = await meta.getArtifactById(inv.artifact_id)
      if (!artifact) return bail(fail(c, 404, "this invitation is invalid or has expired"))
      const inviter = inv.invited_by ? (await meta.getUsers([inv.invited_by]))[0] : undefined
      return c.json({
        title: artifact.title,
        role: inv.role,
        email: inv.email,
        inviter: inviter?.name ?? null,
      })
    },
  )

  // Accept: the signed-in token holder becomes a per-artifact member at the invite's
  // role. Same mismatch contract as workspace invites: possession authorizes, but a
  // different signed-in email must explicitly confirm (409 carries the flow).
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifact-invites/{token}/accept",
      tags: ["Sharing"],
      summary: "Accept an artifact invitation (the signed-in token holder is shared in).",
      request: { params: z.object({ token: z.string() }) },
      responses: {
        200: {
          description: "The artifact joined + the granted role.",
          content: {
            "application/json": {
              schema: z.object({ short_id: z.string(), role: roleEnum }),
            },
          },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      const inv = await meta.getArtifactInviteByToken(sha256(c.req.param("token")))
      if (!inv || inv.accepted_at || new Date(inv.expires_at).getTime() < Date.now())
        return bail(fail(c, 404, "this invitation is invalid or has expired"))
      const artifact = await meta.getArtifactById(inv.artifact_id)
      if (!artifact) return bail(fail(c, 404, "this invitation is invalid or has expired"))
      if (inv.email && me.email && inv.email.toLowerCase() !== me.email.toLowerCase()) {
        const b = await readJson(c, z.object({ confirm_mismatch: z.boolean().optional() }))
        const confirmed = !(b instanceof Response) && b.confirm_mismatch === true
        if (!confirmed) return bail(fail(c, 409, "email_mismatch", { invited_email: inv.email }))
      }
      // An existing share only ever upgrades — accepting a commenter invite while
      // already an editor member must not downgrade the real grant.
      const existing = (await meta.listArtifactMembers(artifact.id)).find(
        (m) => m.user_id === me.id,
      )
      if (!existing || rank(inv.role) > rank(existing.role))
        await meta.setArtifactMember({
          id: existing?.id ?? newId("am"),
          artifact_id: artifact.id,
          user_id: me.id,
          role: inv.role,
        })
      await meta.markArtifactInviteAccepted(inv.id)
      // Any OTHER pending invites for this email on the artifact are now moot.
      await meta.deletePendingArtifactInvitesFor(artifact.id, inv.email)
      return c.json({
        short_id: artifact.short_id,
        role: existing
          ? rank(inv.role) > rank(existing.role)
            ? inv.role
            : existing.role
          : inv.role,
      })
    },
  )

  return app
}

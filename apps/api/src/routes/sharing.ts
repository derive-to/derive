import { type ArtifactRecord, effectiveRole, isRole, newId, ROLES, type Role } from "@derive/core"
import { type Context, Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { buildShareEmail } from "../lib/email"
import { fail, readJson } from "../lib/http"
import { resolveUserRef } from "../lib/resolve-user"
import { enqueueChannelDelivery } from "../webhooks"

/** Per-artifact role overrides (a share). Managing shares requires `share`
 *  (editor+, GDocs model); the share's role beats the caller's workspace baseline. */
export const sharingRoutes = (ctx: AppContext) => {
  const { meta, deps, defaultRole, authorize, actorFor, actingUser, bus } = ctx
  const app = new Hono()

  // A sharer can never grant — or remove — a role above their own. An editor (who
  // has `share` but not `manage`) invites viewers/commenters/editors; only an owner
  // can grant owner. Without this, an editor could PUT themselves `owner` (which
  // confers `manage`) and DELETE the real owner, seizing the artifact.
  const rank = (r: Role | null): number => (r ? ROLES.indexOf(r) : -1)
  const callerRank = async (c: Context, a: ArtifactRecord): Promise<number> =>
    rank(effectiveRole(await actorFor(c, a), a.workspace_access, a.link_role))

  app.get("/v1/artifacts/:shortId/members", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact))) return fail(c, 404, "not found")
    // The member roster is for collaborators, not the public. A caller who only has
    // read access via the artifact's visibility (no membership and no share) gets
    // nothing — mirrors the collection-members gate, and stops a stranger reading a
    // public artifact's collaborator list cross-workspace. Identify members by their
    // public @handle; never expose email.
    const actor = await actorFor(c, artifact)
    const collaborator =
      actor.kind === "token" ||
      (actor.kind === "user" && (actor.orgRole != null || actor.artifactRole != null))
    if (!collaborator) return fail(c, 404, "not found")
    const rows = await meta.listArtifactMembers(artifact.id)
    const users = await meta.getUsers(rows.map((r) => r.user_id))
    const byId = new Map(users.map((u) => [u.id, u]))
    return c.json({
      default_role: defaultRole,
      members: rows.map((r) => ({
        user_id: r.user_id,
        handle: byId.get(r.user_id)?.username ?? null,
        name: byId.get(r.user_id)?.name ?? null,
        role: r.role,
      })),
    })
  })

  app.put("/v1/artifacts/:shortId/members", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return fail(c, 404, "not found")
    if (!(await authorize(c, "share", artifact))) return fail(c, 403, "forbidden")
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
    if (b instanceof Response) return b
    if (rank(b.role) > (await callerRank(c, artifact)))
      return fail(c, 403, "you can't grant a role above your own")
    const id = await resolveUserRef(meta, (b.user ?? b.username ?? b.email) as string)
    const [user] = id ? await meta.getUsers([id]) : []
    if (!user) return fail(c, 404, "no Derive user with that username or email")
    // An artifact keeps at least one owner-member: downgrading the sole owner
    // would orphan it — on `private` visibility, irrecoverably (workspace role
    // grants nothing there, so no one could share it back open).
    if (b.role !== "owner") {
      const members = await meta.listArtifactMembers(artifact.id)
      const owners = members.filter((m) => m.role === "owner")
      if (owners.length === 1 && owners[0]?.user_id === user.id)
        return fail(c, 400, "an artifact keeps at least one owner")
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
    }
    // Echo the public handle, never the email — otherwise sharing by @handle would
    // be a handle→email oracle (resolve anyone's email by sharing an artifact with them).
    return c.json({ user_id: user.id, handle: user.username, name: user.name, role: b.role }, 201)
  })

  app.delete("/v1/artifacts/:shortId/members/:userId", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return fail(c, 404, "not found")
    if (!(await authorize(c, "share", artifact))) return fail(c, 403, "forbidden")
    const members = await meta.listArtifactMembers(artifact.id)
    const target = members.find((m) => m.user_id === c.req.param("userId"))
    if (target && rank(target.role) > (await callerRank(c, artifact)))
      return fail(c, 403, "you can't remove a collaborator who outranks you")
    // Same invariant as the role-change guard above: never remove the last owner.
    if (target?.role === "owner" && members.filter((m) => m.role === "owner").length === 1)
      return fail(c, 400, "an artifact keeps at least one owner")
    await meta.removeArtifactMember(artifact.id, c.req.param("userId"))
    return c.body(null, 204)
  })

  return app
}

import {
  type ArtifactInviteRecord,
  type ArtifactRecord,
  can,
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
import {
  ACCESS_REQUEST_NOTE_MAX,
  accessApprovers,
  accessRequestPreview,
  askerName,
  MAX_ACCESS_APPROVERS,
} from "../lib/access-request"
import { mintToken, sha256 } from "../lib/crypto"
import { buildAccessRequestEmail, buildArtifactInviteEmail, buildShareEmail } from "../lib/email"
import { bail, fail, readJson } from "../lib/http"
import {
  emailMismatch409,
  INVITE_TTL_MS,
  inviteJson,
  isLiveInvite,
  looksLikeEmail,
} from "../lib/invite"
import { resolveUserRef } from "../lib/resolve-user"
import { armInviteAdmission } from "../lib/signup-policy"
import { enqueueSlackShareDm } from "../lib/slack-dm"
import { log } from "../log"
import { ArtifactMember, roleEnum } from "../schemas"
import { enqueueChannelDelivery } from "../webhooks"

/** Per-artifact role overrides (a share). Managing shares requires `share`
 *  (editor+, GDocs model); the share's role beats the caller's workspace baseline.
 *  Members are returned as the shared ArtifactMember shape (generated web type). */
export const sharingRoutes = (ctx: AppContext) => {
  const {
    meta,
    deps,
    defaultRole,
    actorFor,
    actingUser,
    requireUser,
    requireArtifact,
    bus,
    inviteLimiter,
    accessRequestLimiter,
    accessRequestMailLimiter,
    limited,
  } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  // A sharer can never grant — or remove — a role above their own. An editor (who
  // has `share` but not `manage`) invites viewers/commenters/editors; only an owner
  // can grant owner. Without this, an editor could PUT themselves `owner` (which
  // confers `manage`) and DELETE the real owner, seizing the artifact.
  const rank = (r: Role | null): number => (r ? ROLES.indexOf(r) : -1)
  const callerRank = async (c: Context, a: ArtifactRecord): Promise<number> =>
    rank(effectiveRole(await actorFor(c, a), a.workspace_access, a.link_role))

  // ---- Per-artifact invites (share-by-email to someone with no account) ----
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
  // Token → live pending invite + its artifact; null on unknown, spent, expired,
  // or since-deleted — the preview and accept routes resolve identically.
  const liveArtifactInvite = async (
    c: Context,
  ): Promise<{ inv: ArtifactInviteRecord; artifact: ArtifactRecord } | null> => {
    const token = c.req.param("token")
    if (!token) return null
    const inv = await meta.getArtifactInviteByToken(sha256(token))
    if (!inv || !isLiveInvite(inv)) return null
    const artifact = await meta.getArtifactById(inv.artifact_id)
    return artifact ? { inv, artifact } : null
  }

  // ---- Asking for access (the way out of the dead-end 404) ----
  //
  // A signed-in stranger who opens an artifact they cannot read gets a bare 404 whose
  // body and status are identical to one for an artifact that never existed (see
  // routes/artifacts.ts). This route must not become the oracle that pairing is meant
  // to avoid, so it answers 202 `{ok:true}` to EVERY outcome — missing, forbidden,
  // already readable, deduped, no eligible approver — through the single `accepted()`
  // exit, and the wall offers the ask unconditionally.
  //
  // What that buys is bounded, and worth stating exactly, because the guarantee is
  // easy to overclaim: this route adds no new STATUS-CODE or BODY-LEVEL existence
  // oracle. It does not make existence unlearnable. Two things it deliberately does
  // not fix:
  //   - Work done before the response differs by branch (one store round trip for a
  //     miss, several for a real artifact), so the reply time still separates them.
  //     The pre-existing GET has the same asymmetry, widened on purpose for latency
  //     (artifacts.ts, the "404 BEFORE resolving an actor" note).
  //   - POST /report, PATCH /locked, and every `requireArtifact({split:true})` route
  //     already answer "does this exist" directly, by design (context.ts documents the
  //     split as intentional).
  // Two things it does fix, because both were real oracles in an earlier draft of this
  // route: the mail bar is now consumed BEFORE the artifact lookup, so probing a
  // fabricated id costs the caller exactly what probing a real one costs (a limiter
  // spent only on the exists-and-forbidden branch is readable cross-endpoint, and
  // readable by a confederate with no timing analysis at all); and it is called
  // directly rather than through `limited()`, which writes a Retry-After header that
  // Hono then carries onto whatever response the handler returns — including this 202.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{shortId}/access-request",
      tags: ["Sharing"],
      summary: "Ask the people who can share an artifact to grant you access.",
      description:
        "202 for every outcome once the caller is authenticated and the body validates — missing artifact, no access, already readable, or already asked. The response deliberately does not reveal which.",
      request: {
        params: z.object({ shortId: z.string() }),
        body: {
          required: false,
          content: {
            "application/json": {
              schema: z.object({
                note: z
                  .string()
                  .max(ACCESS_REQUEST_NOTE_MAX)
                  .optional()
                  .describe("Optional message to the approvers: who you are, why you need it."),
              }),
            },
          },
        },
      },
      responses: {
        202: {
          description: "The request was accepted. Says nothing about what followed.",
          content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } },
        },
        400: { description: "The note is longer than the limit." },
        401: { description: "Not signed in — a grant needs an identity to attach to." },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      const b = await readJson(
        c,
        z.object({ note: z.string().max(ACCESS_REQUEST_NOTE_MAX).optional() }),
      )
      if (b instanceof Response) return bail(b)
      const note = b.note?.trim() ? b.note.trim() : null
      // The single exit. Every return below funnels through it so no branch can grow a
      // distinguishable response.
      const accepted = () => c.json({ ok: true as const }, 202)

      // The mail bar, FIRST — before the lookup, so every call costs the same whether
      // or not the artifact is real. Called directly, not via `limited()`: that helper
      // returns a 429 whose Retry-After header Hono has already written into the
      // context, and it would ride out on the 202 below.
      if (accessRequestMailLimiter && !(await accessRequestMailLimiter(`id:${me.id}`)).ok)
        return accepted()

      // Inside the try from here on. The read gate is not the cheap half: `actorFor`
      // resolves grants through a four-arm union plus the collection lookup, so it is
      // one of the heaviest calls on the route and it runs ONLY when the artifact
      // exists. Leaving it outside meant a fault that reached the grants query but not
      // the single-table getByShortId — schema drift on a preview deploy, a statement
      // timeout — turned a real artifact into a 500 and a fabricated one into a 202.
      // That is the same oracle in a louder voice.
      try {
        const shortId = c.req.param("shortId")
        const artifact = shortId ? await meta.getByShortId(shortId) : null
        if (!artifact || artifact.removed_at) return accepted()
        // Nothing to ask for. Answering differently here would also tell a caller
        // whether a grant they hold covers an artifact they cannot see listed.
        const actor = await actorFor(c, artifact)
        if (can(actor, "read", artifact.workspace_access, artifact.link_role)) return accepted()

        // Resolve and filter BEFORE the cap. Slicing ids would spend slots on rows that
        // resolve to nothing (a deleted account leaves its artifact_member row behind)
        // and on the asker themselves — who sorts FIRST when their own grant is
        // workspace-bound and their active workspace is elsewhere, so the sole owner of
        // an artifact could ask for access and knock the only other approver off the end
        // of the list. PRE_RESOLVE_CAP keeps the getUsers argument bounded on a large
        // workspace without letting the real cap eat unresolvable ids.
        const approvers = await accessApprovers(meta, artifact)
        // Re-impose accessApprovers' order. `getUsers` is a WHERE id IN (…) with no
        // ORDER BY on any driver, so it hands rows back in whatever order the plan
        // produced — which threw the ranking away entirely and made the cut arbitrary:
        // the artifact's own owner sorts first and was dropped whenever their id
        // happened to sort late. Worse, "arbitrary" is not even stable, so a retry could
        // fan out to a different five.
        const byId = new Map((await meta.getUsers(approvers)).map((u) => [u.id, u]))
        const recipients = approvers
          .flatMap((id) => {
            const u = byId.get(id)
            return u && u.id !== me.id ? [u] : []
          })
          .slice(0, MAX_ACCESS_APPROVERS)
        // Bail BEFORE spending the dedupe token. getUsers swallows its own errors and
        // returns [] by contract, so an empty roster can mean "nobody can grant" or "the
        // store blinked" — and burning the window on the second would tell the asker
        // "Request sent" and then silently swallow every retry until it expired.
        if (!recipients.length) return accepted()
        if (!(await accessRequestLimiter(`${me.id}:${artifact.short_id}`)).ok) return accepted()

        const preview = accessRequestPreview(me, note)
        const rows = recipients.map((u) => ({
          id: newId("n"),
          user_id: u.id,
          actor: askerName(me),
          kind: "access_request" as const,
          artifact_id: artifact.id,
          artifact_short_id: artifact.short_id,
          artifact_title: artifact.title,
          // No comment thread to anchor to, same as a share — the bell opens the artifact.
          thread_id: "",
          comment_id: "",
          preview,
        }))
        await meta.createNotifications(rows)
        for (const row of rows)
          bus.publish(`u:${row.user_id}`, {
            type: "notification",
            notification: { ...row, read: 0, created_at: new Date().toISOString() },
          })
        // Email on the same workspace gate as the other notification mail. A bell alone
        // is not enough here: the approver may not open Derive for days, and the asker is
        // stuck looking at a 404 until one of them acts. Concurrent, like notify-email's
        // fan-out — serially awaiting N enqueues inside the handler stretches exactly the
        // branch whose duration is already the loudest thing about this route.
        if ((await meta.getOrgSettings(artifact.org_id)).emailNotifications)
          await Promise.all(
            recipients
              .filter((u) => u.email)
              .map((u) =>
                enqueueChannelDelivery(meta, "email", "artifact.access_requested", {
                  to: u.email,
                  toName: u.name ?? undefined,
                  ...buildAccessRequestEmail(deps.baseUrl, artifact, { asker: me, note }),
                }),
              ),
          )
      } catch (err) {
        // The RESPONSE is swallowed on purpose — the asker must not learn from a 500
        // what the 202 refuses to tell them. The ERROR is not: past the dedupe consume
        // this is a request that reported "sent" and sent nothing, and the asker is
        // suppressed until the window expires. The access log only records a 202, so
        // without this line the failure is invisible to everyone, including the asker.
        log.error("access request failed", {
          short_id: c.req.param("shortId"),
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return accepted()
    },
  )

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
      const artifact = await requireArtifact(c, "read")
      if (artifact instanceof Response) return bail(artifact)
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
      // themselves share (editor+) see them — a viewer-collaborator gets an empty
      // list. `can` on the already-resolved actor: authorize() would re-resolve it
      // (a third time on this route).
      const invites = can(actor, "share", artifact.workspace_access, artifact.link_role)
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
      const artifact = await requireArtifact(c, "share", { split: true })
      if (artifact instanceof Response) return bail(artifact)
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
        // No account behind that ref. An email becomes a pending invite — created
        // here, emailed, redeemed at signup. An unknown @handle stays a plain miss.
        const email = ref.trim().toLowerCase()
        if (!looksLikeEmail(email))
          return bail(fail(c, 404, "no Derive user with that username or email"))
        // Ownership is workspace authority, not a portable artifact share. An
        // unknown invitee cannot already hold a seat, so invite them to the
        // workspace before transferring ownership.
        if (b.role === "owner")
          return bail(fail(c, 400, "an artifact owner must belong to its workspace"))
        // Each invite emails an arbitrary address with the caller's artifact title
        // in the subject — rate-limited so an account can't run a spam cannon.
        const rl = await limited(c, inviteLimiter)
        if (rl) return bail(rl)
        // A fresh token supersedes any prior pending invite for this (artifact, email).
        await meta.deletePendingArtifactInvitesFor(artifact.id, email)
        const token = mintToken("dka")
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
      if (b.role === "owner" && !(await meta.getMembership(artifact.org_id, user.id)))
        return bail(fail(c, 400, "an artifact owner must belong to its workspace"))
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
      const artifact = await requireArtifact(c, "share", { split: true })
      if (artifact instanceof Response) return bail(artifact)
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
      const artifact = await requireArtifact(c, "share", { split: true })
      if (artifact instanceof Response) return bail(artifact)
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
      const live = await liveArtifactInvite(c)
      if (!live) return bail(fail(c, 404, "this invitation is invalid or has expired"))
      const { inv, artifact } = live
      await armInviteAdmission(
        c,
        "artifact",
        sha256(c.req.param("token")),
        inv.expires_at,
        deps.encryptionKey,
        { baseUrl: deps.baseUrl, crossSite: deps.crossSite },
      )
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
      const live = await liveArtifactInvite(c)
      if (!live) return bail(fail(c, 404, "this invitation is invalid or has expired"))
      const { inv, artifact } = live
      const mismatch = await emailMismatch409(c, inv.email, me.email)
      if (mismatch) return bail(mismatch)
      // Historical owner invitations may predate the workspace-bound ownership
      // invariant. Refuse them without consuming the token; joining the workspace
      // first makes the same invite redeemable.
      if (inv.role === "owner" && !(await meta.getMembership(artifact.org_id, me.id)))
        return bail(fail(c, 400, "an artifact owner must belong to its workspace"))
      const now = new Date().toISOString()
      if (!(await meta.consumeArtifactInvite(inv.id, now)))
        return bail(fail(c, 409, "this invitation has already been accepted"))
      // An existing share only ever upgrades — accepting a commenter invite while
      // already an editor member must not downgrade the real grant.
      const existing = await meta.getArtifactMember(artifact.id, me.id)
      const granted = existing && rank(existing.role) >= rank(inv.role) ? existing.role : inv.role
      if (granted !== existing?.role)
        await meta.setArtifactMember({
          id: existing?.id ?? newId("am"),
          artifact_id: artifact.id,
          user_id: me.id,
          role: granted,
        })
      // Any OTHER pending invites for this email on the artifact are now moot.
      await meta.deletePendingArtifactInvitesFor(artifact.id, inv.email)
      return c.json({ short_id: artifact.short_id, role: granted })
    },
  )

  return app
}

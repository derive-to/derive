import { newId } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { mintToken } from "../lib/crypto"
import { bail, DEFAULT_WORKSPACE_NAME, fail, readJson } from "../lib/http"
import {
  isJoinLinkRole,
  isLiveJoinLink,
  JOIN_LINK_TTL_MS,
  type JoinLinkRole,
  joinLinkJson,
} from "../lib/join-link"
import { syncSeats } from "../lib/seats"
import { armInviteAdmission } from "../lib/signup-policy"
import { roleEnum } from "../schemas"

/** The workspace join link: ONE shareable URL per workspace that lets anyone who opens it
 *  join at the link's role (Creator or Viewer, never Admin). Admin-managed, revocable, 30-day
 *  expiry, seat-gated at join exactly like an email invite. The WorkspaceJoinLink /
 *  JoinLinkPreview / JoinResult schemas are the single source for the web client's types. */
export const workspaceJoinRoutes = (ctx: AppContext) => {
  const { meta, deps, requireUser, currentUser, requireWorkspace, seatGrantGate } = ctx
  const billing = deps.billing
  const app = new OpenAPIHono<BlankEnv>()

  const WorkspaceJoinLink = z
    .object({
      id: z.string(),
      role: roleEnum.describe(
        "The role a joiner receives: commenter (Viewer) or editor (Creator).",
      ),
      url: z.string().describe("The shareable URL. The token rides only here."),
      created_at: z.string(),
      expires_at: z.string().describe("Fixed 30 days from creation; rotate to extend."),
      join_count: z.number().int().describe("How many people have joined through this link."),
    })
    .openapi("WorkspaceJoinLink")

  const JoinLinkPreview = z
    .object({
      workspace: z.string(),
      role: roleEnum,
      inviter: z.string().nullable().describe("Display name of the Admin who made the link."),
      expires_at: z.string(),
    })
    .openapi("JoinLinkPreview")

  const JoinResult = z
    .object({
      org_id: z.string(),
      role: roleEnum.describe("The caller's role in the workspace after the call."),
      already_member: z
        .boolean()
        .describe("True when the caller was already a member; their role is never changed."),
    })
    .openapi("JoinResult")

  const urlFor = (token: string) => `${deps.baseUrl.replace(/\/$/, "")}/join/${token}`

  // ---- Admin side: the workspace's one link ------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/workspace/join-link",
      tags: ["Workspace"],
      summary: "The workspace's join link (Admin only); 404 when none exists.",
      responses: {
        200: {
          description: "The current link.",
          content: { "application/json": { schema: WorkspaceJoinLink } },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const link = await meta.getJoinLink(org)
      if (!link) return bail(fail(c, 404, "this workspace has no join link"))
      return c.json(joinLinkJson(link, urlFor(link.token)))
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/workspace/join-link",
      tags: ["Workspace"],
      summary: "Create the workspace's join link, or rotate it (Admin only).",
      responses: {
        201: {
          description: "The fresh link. Any previous link stops working.",
          content: { "application/json": { schema: WorkspaceJoinLink } },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const b = await readJson(
        c,
        z.object({
          role: z
            .custom<JoinLinkRole>(isJoinLinkRole, "role must be commenter or editor")
            .optional(),
        }),
      )
      if (b instanceof Response) return bail(b)
      // Creator by default: an activated team is one where members publish, and Viewers can't.
      const role: JoinLinkRole = b.role ?? "editor"
      const me = await currentUser(c)
      const link = await meta.replaceJoinLink({
        id: newId("wjl"),
        org_id: org,
        role,
        token: mintToken("dkj"),
        created_by: me?.id ?? null,
        expires_at: new Date(Date.now() + JOIN_LINK_TTL_MS).toISOString(),
      })
      return c.json(joinLinkJson(link, urlFor(link.token)), 201)
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/workspace/join-link",
      tags: ["Workspace"],
      summary: "Revoke the workspace's join link (Admin only).",
      responses: { 204: { description: "Revoked (or there was none)." } },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      await meta.deleteJoinLink(org)
      return c.body(null, 204)
    },
  )

  // ---- Joiner side: the link itself --------------------------------------
  // Preview: the token IS the secret (possession authorizes), so no auth. A valid preview arms
  // signup admission so a brand-new person can create an account on an invite-only instance.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/join/{token}",
      tags: ["Workspace"],
      summary: "Preview a join link (the join page reads this).",
      request: { params: z.object({ token: z.string() }) },
      responses: {
        200: {
          description: "The workspace and role the link grants.",
          content: { "application/json": { schema: JoinLinkPreview } },
        },
      },
    }),
    async (c) => {
      const link = await meta.getJoinLinkByToken(c.req.param("token"))
      if (!link) return bail(fail(c, 404, "this join link is invalid or has been revoked"))
      if (!isLiveJoinLink(link))
        return bail(fail(c, 410, "this join link has expired", { code: "join_link_expired" }))
      await armInviteAdmission(c, "join", link.id, link.expires_at, deps.encryptionKey, {
        baseUrl: deps.baseUrl,
        crossSite: deps.crossSite,
      })
      const ws = await meta.getWorkspace(link.org_id)
      const inviter = link.created_by ? (await meta.getUsers([link.created_by]))[0] : undefined
      return c.json({
        workspace: ws?.name ?? DEFAULT_WORKSPACE_NAME,
        role: link.role,
        inviter: inviter?.name ?? null,
        expires_at: link.expires_at,
      })
    },
  )

  // Join: the signed-in holder becomes a member at the link's role. Idempotent for members
  // (never a downgrade); the same seat gate as an email invite for a Creator link.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/join/{token}",
      tags: ["Workspace"],
      summary: "Join the workspace through its link (signed-in holder).",
      request: { params: z.object({ token: z.string() }) },
      responses: {
        200: {
          description: "The workspace joined and the caller's role in it.",
          content: { "application/json": { schema: JoinResult } },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      const link = await meta.getJoinLinkByToken(c.req.param("token"))
      if (!link) return bail(fail(c, 404, "this join link is invalid or has been revoked"))
      if (!isLiveJoinLink(link))
        return bail(fail(c, 410, "this join link has expired", { code: "join_link_expired" }))
      const existing = await meta.getMembership(link.org_id, me.id)
      if (existing)
        return c.json({ org_id: link.org_id, role: existing.role, already_member: true })
      const gated = await seatGrantGate(c, link.org_id, link.role)
      if (gated) return bail(gated)
      await meta.setMembership({
        id: newId("m"),
        org_id: link.org_id,
        user_id: me.id,
        role: link.role,
      })
      await syncSeats({ meta, billing }, link.org_id)
      await meta.recordJoin(link.id)
      return c.json({ org_id: link.org_id, role: link.role, already_member: false })
    },
  )

  return app
}

import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { parseConnectionIds } from "../lib/broker"
import { readEnvironmentBindings } from "../lib/context-environment"
import { credentialRevision, credentialView, credentialVisible } from "../lib/credentials"
import { encryptSecret } from "../lib/crypto"
import { fail, readJson } from "../lib/http"
import { canManageAgent } from "../lib/jobs"
import { verifySecretUploadToken } from "../lib/secret-upload-token"
import { saveSecret } from "../lib/secrets"

/** The same ceiling POST /v1/connections puts on a secret value. */
const MAX_SECRET_CHARS = 4096

/** Credential management is a view of existing secret connections, not another vault. */
export const credentialRoutes = (ctx: AppContext) => {
  const app = new Hono()
  const principal = async (c: Context) => {
    c.header("Cache-Control", "no-store")
    const org = await ctx.requireWorkspace(c, "read")
    if (org instanceof Response) return org
    const userId = await ctx.managementPrincipal(c)
    if (!userId) return fail(c, 401, "A signed-in user or management grant is required")
    return { org, userId }
  }
  const owned = async (c: Context) => {
    const auth = await principal(c)
    if (auth instanceof Response) return auth
    const connection = await ctx.meta.getConnection(c.req.param("id") ?? "")
    if (
      !connection ||
      connection.org_id !== auth.org ||
      !credentialVisible(connection, auth.userId)
    )
      return fail(c, 404, "not found")
    const canManage = await ctx.workspaceCan(c, "manage")
    if (connection.scope === "workspace" && !canManage)
      return fail(c, 403, "Workspace management access is required")
    return { ...auth, connection, canManage }
  }
  app.get("/v1/credentials", async (c) => {
    const auth = await principal(c)
    if (auth instanceof Response) return auth
    const canManage = await ctx.workspaceCan(c, "manage")
    return c.json({
      can_create_workspace: canManage,
      items: (await ctx.meta.listConnections(auth.org))
        .filter((connection) => credentialVisible(connection, auth.userId))
        .map((connection) => credentialView(connection, auth.userId, canManage)),
    })
  })
  // Which agents a secret reaches: bound as a source, or named in an agent's environment.
  // Agents are workspace-visible (GET /v1/agents), so nothing here is hidden from a member.
  app.get("/v1/credentials/:id/usage", async (c) => {
    const auth = await owned(c)
    if (auth instanceof Response) return auth
    const items: { id: string; name: string; kind: "agent" }[] = []
    for (const agent of await ctx.meta.listAgents(auth.org)) {
      const ids = [
        ...parseConnectionIds(agent.connection_ids_json),
        ...Object.values(readEnvironmentBindings(agent.environment_json)),
      ]
      if (ids.includes(auth.connection.id))
        items.push({ id: agent.id, name: agent.name, kind: "agent" })
    }
    return c.json({ items, hidden_count: 0 })
  })
  app.put("/v1/credentials/:id", async (c) => {
    const auth = await owned(c)
    if (auth instanceof Response) return auth
    const body = await readJson(
      c,
      z.object({
        name: z.string().trim().min(1).max(200),
        secret: z
          .string()
          .min(1)
          .max(4096)
          .refine((value) => !value.includes("\0"), "Value cannot contain a null character"),
        revision: z.string().length(64),
      }),
    )
    if (body instanceof Response) return body
    if (!ctx.deps.encryptionKey) return fail(c, 503, "Credential storage is not configured")
    if (
      auth.connection.status !== "active" ||
      credentialRevision(auth.connection) !== body.revision
    )
      return fail(c, 409, "Credential changed or was revoked. Reload before replacing it.")
    const updated = await ctx.meta.updateConnectionCredential(
      auth.connection.id,
      auth.org,
      {
        secret_enc: encryptSecret(body.secret, ctx.deps.encryptionKey),
        scopes_label: body.name,
      },
      auth.connection.secret_enc,
      "active",
    )
    if (!updated)
      return fail(c, 409, "Credential changed or was revoked. Reload before replacing it.")
    return c.json(credentialView(updated, auth.userId, auth.canManage))
  })

  // A secret sent from a shell with a URL the MCP `stage` tool minted (target:'secret'), so
  // the value never passes through a model. The body is the raw value, as
  // `curl --data-binary @file` sends it. See lib/secret-upload-token.ts.
  app.post("/v1/secrets/t/:token", async (c) => {
    c.header("Cache-Control", "no-store")
    const key = ctx.deps.encryptionKey
    const claim = key ? await verifySecretUploadToken(key, c.req.param("token"), Date.now()) : null
    if (!key || !claim) return fail(c, 403, "invalid or expired upload link")
    // Re-checked at spend: losing the seat, or management of the agent, voids the link.
    if (!(await ctx.meta.getMembership(claim.orgId, claim.userId).catch(() => null)))
      return fail(c, 403, "invalid or expired upload link")
    const agent = claim.agentId ? await ctx.meta.getAgent(claim.agentId) : null
    if (
      claim.agentId &&
      (!agent ||
        agent.org_id !== claim.orgId ||
        !(await canManageAgent(ctx.meta, agent, claim.userId)))
    )
      return fail(c, 403, "you no longer manage that agent")
    if (Number(c.req.header("content-length") ?? 0) > MAX_SECRET_CHARS * 4)
      return fail(c, 413, "a secret is at most 4096 characters")
    // A file almost always ends with one newline that is not part of the value.
    const value = (await c.req.text()).replace(/\r?\n$/, "")
    if (!value) return fail(c, 400, "the value is empty")
    if (value.length > MAX_SECRET_CHARS) return fail(c, 413, "a secret is at most 4096 characters")
    if (value.includes("\0")) return fail(c, 400, "Value cannot contain a null character")
    const { secret, outcome } = await saveSecret(ctx.meta, key, {
      orgId: claim.orgId,
      userId: claim.userId,
      scope: "personal",
      name: claim.name,
      value,
      toolkit: "environment",
      reuse: true,
    })
    if (agent && claim.variable) {
      const environment = { ...readEnvironmentBindings(agent.environment_json) }
      environment[claim.variable] = secret.id
      await ctx.meta.updateAgent(agent.id, agent.org_id, {
        environment_json: JSON.stringify(environment),
      })
    }
    return c.json(
      {
        id: secret.id,
        name: secret.scopes_label ?? claim.name,
        reused: outcome === "reused",
        bound: agent && claim.variable ? { agent: agent.name, variable: claim.variable } : null,
      },
      outcome === "created" ? 201 : 200,
    )
  })
  return app
}

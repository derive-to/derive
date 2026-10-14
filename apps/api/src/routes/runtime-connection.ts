import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { BoatClient } from "../lib/boat-client"
import { encryptSecret } from "../lib/crypto"
import { bail, fail } from "../lib/http"
import { OrtamClient } from "../lib/ortam-client"
import {
  BOAT_API_URL,
  managedFor,
  ORTAM_API_URL,
  runtimeConnection,
  runtimeConnectionId,
  sandboxApiUrl,
  workspaceRuntime,
} from "../lib/runtime-connection"
import { log } from "../log"
import { accountConnectionPending, stopAccountConnection } from "./account-login"

const Connection = z
  .object({
    available: z.boolean(),
    provider: z.enum(["boat", "ortam"]),
    connected: z.boolean(),
    account_id: z.string().nullable(),
    can_manage: z.boolean(),
    snapshot: z.string().nullable(),
    managed: z
      .boolean()
      .describe("Cloud work runs on the deployment's own machines when nothing is connected."),
  })
  .openapi("ComputeConnection")
const response = {
  description: "Workspace compute connection. No credential.",
  content: {
    "application/json": { schema: Connection },
  },
}

export const runtimeConnectionRoutes = (ctx: AppContext) => {
  const { meta, deps, requireWorkspace } = ctx
  const app = new OpenAPIHono<BlankEnv>()
  const available = !!deps.encryptionKey && !!deps.runtime && !!meta.jobExecution
  const view = async (org: string, canManage: boolean) => {
    const cn = await runtimeConnection(meta, org)
    return {
      available,
      provider: (await workspaceRuntime(meta, deps.runtime, org)).provider,
      connected: cn?.status === "active",
      account_id: cn?.status === "active" ? cn.broker_ref : null,
      can_manage: canManage,
      snapshot:
        cn?.toolkit === "boat" ? ((await meta.getOrgSettings(org)).boatSnapshot ?? null) : null,
      managed: available && managedFor(deps.runtime, org),
    }
  }

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/runtime/connection",
      tags: ["Agents"],
      summary: "The workspace's sandbox connection.",
      responses: { 200: response },
    }),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const org = await requireWorkspace(c, "read")
      if (org instanceof Response) return bail(org)
      return c.json(await view(org, await ctx.workspaceCan(c, "manage")))
    },
  )

  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/runtime/connection",
      tags: ["Agents"],
      summary: "Verify and connect the workspace's sandbox API key.",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                api_key: z.string().trim().min(8).max(4096),
                provider: z.enum(["boat", "ortam"]).default("boat"),
              }),
            },
          },
        },
      },
      responses: { 200: response },
    }),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const who = await ctx.managementPrincipal(c)
      if (!who) return bail(fail(c, 403, "A workspace owner connects cloud compute"))
      const key = deps.encryptionKey
      if (!key || !available)
        return bail(fail(c, 503, "Cloud compute is not enabled on this server"))
      const old = await runtimeConnection(meta, org)
      const input = c.req.valid("json")
      const label = input.provider === "boat" ? "boat.dev" : "Ortam"
      if (old && old.toolkit !== input.provider && old.status === "active")
        return bail(fail(c, 409, "Disconnect the current sandbox provider before switching."))
      let identity: { user_id: string; organization_id: string }
      try {
        identity = await (input.provider === "boat"
          ? new BoatClient(BOAT_API_URL, input.api_key, deps.runtimeFetch)
          : new OrtamClient(ORTAM_API_URL, input.api_key, "", deps.runtimeFetch, "api_key")
        ).authenticate()
      } catch {
        return bail(
          fail(
            c,
            400,
            `${label} could not verify this key. Check the key and its sandbox permissions, then try again.`,
          ),
        )
      }
      // A sandbox belongs to the account that created it. Rotation must keep that identity.
      const account =
        input.provider === "boat"
          ? identity.user_id
          : `${identity.organization_id}:${identity.user_id}`
      if (!old || old.toolkit !== input.provider || old.broker_ref !== account) {
        if (old?.status === "active")
          return bail(
            fail(
              c,
              409,
              "This key belongs to another account. Disconnect the current account first.",
            ),
          )
        const agents = await meta.listAgents(org)
        if (agents.some((a) => a.sandbox_phase !== null && a.sandbox_phase !== "failed"))
          return bail(
            fail(
              c,
              409,
              "The previous account is still stopping its compute. Try again when it finishes.",
            ),
          )
      }
      if (old && old.toolkit !== input.provider) {
        // Disconnect keeps the old credential for cleanup. Replacement is safe only
        // after every sandbox is retired, and never while a model login owns compute.
        if ((await meta.listAccounts(org)).some((a) => accountConnectionPending(a, key)))
          return bail(fail(c, 409, "Finish or cancel model sign-in before switching providers."))
      }
      const secret_enc = encryptSecret(input.api_key, key)
      if (old) {
        const saved = await meta.updateConnectionCredential(
          old.id,
          org,
          {
            secret_enc,
            broker_ref: account,
            status: "active",
            toolkit: input.provider,
            base_url: sandboxApiUrl(input.provider),
            scopes_label: label,
          },
          old.secret_enc,
          old.status,
        )
        if (!saved) return bail(fail(c, 409, "This connection changed. Open it again."))
      } else {
        try {
          await meta.createConnection({
            id: runtimeConnectionId(org),
            org_id: org,
            user_id: who,
            scope: "workspace",
            kind: "runtime",
            toolkit: input.provider,
            broker: "none",
            broker_ref: account,
            base_url: sandboxApiUrl(input.provider),
            secret_enc,
            status: "active",
            scopes_label: label,
          })
        } catch {
          return bail(fail(c, 409, "This connection changed. Open it again."))
        }
      }
      return c.json(await view(org, true))
    },
  )

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/runtime/connection",
      tags: ["Agents"],
      summary: "Choose the workspace's Boat snapshot for new agent sandboxes.",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                snapshot: z
                  .string()
                  .trim()
                  .min(1)
                  .max(120)
                  .regex(/^[a-zA-Z0-9_-]+$/)
                  .nullable(),
              }),
            },
          },
        },
      },
      responses: { 200: response },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      if (!(await ctx.managementPrincipal(c)))
        return bail(fail(c, 403, "A workspace owner chooses the runner setup"))
      if (!available) return bail(fail(c, 503, "Cloud compute is not enabled on this server"))
      const cn = await runtimeConnection(meta, org)
      if (cn?.status !== "active" || cn.toolkit !== "boat")
        return bail(fail(c, 409, "Connect boat.dev to choose a Boat snapshot"))
      await meta.setBoatSnapshot(org, c.req.valid("json").snapshot)
      return c.json(await view(org, true))
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/runtime/connection",
      tags: ["Agents"],
      summary: "Disconnect workspace compute and stop its active work.",
      responses: { 200: response },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const cn = await runtimeConnection(meta, org)
      if (cn) {
        // Retain the encrypted key for archive operations. No new work can spend it.
        const changed = await meta.updateConnectionCredential(
          cn.id,
          org,
          { status: "revoked" },
          cn.secret_enc,
          cn.status,
        )
        if (!changed) return bail(fail(c, 409, "This connection changed. Open it again."))
        for (const a of await meta.listAccounts(org)) {
          if (a.status !== "connecting") continue
          await meta.updateAccount(a.id, org, { status: "needs_attention" }, a.secret_enc)
          await ctx.afterResponse(c, () =>
            stopAccountConnection(ctx, a).catch(() => {
              log.warn("compute login cleanup deferred", { account: a.id })
            }),
          )
        }
      }
      return c.json(await view(org, true))
    },
  )
  return app
}

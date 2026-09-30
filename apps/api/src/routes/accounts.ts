import { type AccountRecord, newId, WORKSPACE_ACCOUNT_OWNER } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { encryptSecret } from "../lib/crypto"
import { bail, fail, readJson } from "../lib/http"

// MODEL ACCOUNTS: the credential a machine uses to call a model. A person owns theirs; a
// workspace owner may add a shared one for the whole workspace. Values are write-only: this API
// returns the last four characters and never the secret.

const Account = z
  .object({
    id: z.string(),
    provider: z.enum(["claude", "codex"]),
    kind: z.enum(["oauth", "api_key", "login", "ortam_signin"]),
    shared: z.boolean().describe("A workspace account every agent may fall back to."),
    mine: z.boolean(),
    hint: z.string().nullable(),
    status: z.enum(["ready", "needs_signin", "not_checked"]),
    created_at: z.string(),
  })
  .openapi("ModelAccount")

export const accountRoutes = (ctx: AppContext) => {
  const { meta, deps } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  const accountJson = (a: AccountRecord, me: string) => ({
    id: a.id,
    provider: a.provider,
    kind: a.kind,
    shared: a.user_id === WORKSPACE_ACCOUNT_OWNER,
    mine: a.user_id === me,
    hint: a.hint,
    status: a.status,
    created_at: a.created_at,
  })

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/accounts",
      tags: ["Accounts"],
      summary: "Your model accounts, and the workspace's shared ones.",
      responses: {
        200: {
          description: "Accounts.",
          content: { "application/json": { schema: z.object({ accounts: z.array(Account) }) } },
        },
      },
    }),
    async (c) => {
      const org = await ctx.requireWorkspace(c, "read")
      if (org instanceof Response) return bail(org)
      const who = await ctx.actingHuman(c)
      if (!who) return bail(fail(c, 401, "unauthenticated"))
      const accounts = await meta.listAccounts(org, who.id)
      return c.json({ accounts: accounts.map((a) => accountJson(a, who.id)) })
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/accounts",
      tags: ["Accounts"],
      summary: "Add a model account by pasting a key or a login. Shared accounts need an owner.",
      responses: {
        201: { description: "The account.", content: { "application/json": { schema: Account } } },
      },
    }),
    async (c) => {
      const org = await ctx.requireWorkspace(c, "publish")
      if (org instanceof Response) return bail(org)
      const who = await ctx.managementPrincipal(c)
      if (!who) return bail(fail(c, 403, "a signed-in person adds accounts"))
      const b = await readJson(
        c,
        z.object({
          provider: z.enum(["claude", "codex"]),
          kind: z.enum(["oauth", "api_key", "login"]),
          secret: z.string().trim().min(8).max(20_000),
          shared: z.boolean().default(false),
        }),
      )
      if (b instanceof Response) return bail(b)
      if (b.shared && !(await ctx.workspaceCan(c, "manage")))
        return bail(fail(c, 403, "only a workspace owner adds a shared account"))
      if (!deps.encryptionKey) return bail(fail(c, 503, "Secret encryption is not configured"))
      const a = await meta.createAccount({
        id: newId("acct"),
        org_id: org,
        user_id: b.shared ? WORKSPACE_ACCOUNT_OWNER : who,
        provider: b.provider,
        kind: b.kind,
        secret_enc: encryptSecret(b.secret, deps.encryptionKey),
        hint: `…${b.secret.slice(-4)}`,
      })
      return c.json(accountJson(a, who), 201)
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/accounts/{id}",
      tags: ["Accounts"],
      summary: "Disconnect an account. Yours, or a shared one if you own the workspace.",
      request: { params: z.object({ id: z.string() }) },
      responses: { 204: { description: "Disconnected." } },
    }),
    async (c) => {
      const org = await ctx.requireWorkspace(c, "read")
      if (org instanceof Response) return bail(org)
      const who = await ctx.managementPrincipal(c)
      if (!who) return bail(fail(c, 403, "forbidden"))
      const a = await meta.getAccount(c.req.param("id"))
      const allowed =
        a &&
        a.org_id === org &&
        (a.user_id === who ||
          (a.user_id === WORKSPACE_ACCOUNT_OWNER && (await ctx.workspaceCan(c, "manage"))))
      if (!a || !allowed) return bail(fail(c, 404, "account not found"))
      await meta.deleteAccount(a.id, org)
      // An agent assigned this account falls back to the asker's and the pool's.
      for (const ag of await meta.listAgents(org))
        if (ag.account_id === a.id) await meta.updateAgent(ag.id, org, { account_id: null })
      return c.body(null, 204)
    },
  )

  return app
}

import { type AccountRecord, newId, WORKSPACE_ACCOUNT_OWNER } from "@derive/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { ACCOUNT_LOGIN_SETUP } from "../lib/account-login-script"
import { signCapabilityToken, verifyCapabilityToken } from "../lib/capability-token"
import { decryptSecret, encryptSecret, sha256 } from "../lib/crypto"
import { fail, readJson } from "../lib/http"
import { hasSeat } from "../lib/job-accounts"
import { ORTAM_NODE_SETUP, OrtamClient } from "../lib/ortam-client"
import {
  cloudEnabled,
  connectionClient,
  managedFor,
  runtimeConnection,
  workspaceRuntime,
} from "../lib/runtime-connection"
import type { SandboxClient } from "../lib/sandbox-client"

const DOMAIN = "derive-account-login:"
const Pending = z.object({
  attempt: z.string(),
  owner: z.string(),
  expires: z.number(),
  phase: z.enum(["starting", "awaiting", "checking", "failed"]),
  sandbox_id: z.string().optional(),
  // Old attempts were Boat-only. New attempts pin their provider for callbacks and cleanup.
  provider: z.enum(["boat", "ortam"]).default("boat"),
  api_url: z.string().optional(),
  connection_id: z.string().optional(),
  credential_enc: z.string().optional(),
  identity: z.object({ organization_id: z.string(), user_id: z.string() }),
  verification_url: z.literal("https://auth.openai.com/codex/device").optional(),
  user_code: z
    .string()
    .regex(/^[A-Z0-9-]{4,20}$/)
    .optional(),
  reason: z.string().optional(),
  secret: z.string().optional(),
  previous: z
    .object({
      secret_enc: z.string(),
      kind: z.enum(["login", "api_key", "oauth"]),
      status: z.enum(["ready", "not_checked"]),
      hint: z.string().nullable(),
    })
    .optional(),
})
type PendingLogin = z.infer<typeof Pending>
const readPending = (a: AccountRecord, key: string | undefined): PendingLogin | null => {
  if (!key || !a.secret_enc || !["connecting", "needs_attention"].includes(a.status)) return null
  try {
    return Pending.parse(JSON.parse(decryptSecret(a.secret_enc, key)))
  } catch {
    return null
  }
}
export const accountConnectionPending = (a: AccountRecord, key: string | undefined) =>
  readPending(a, key) !== null

const messages: Record<string, string> = {
  expired: "This code expired. Let’s try again.",
  approval_failed: "Approval did not finish. Let’s try again.",
  check_timed_out: "The access check took too long. Try again.",
  access_failed:
    "This account could not run the access check. Check your plan or key, then reconnect.",
  provider_unavailable: "We could not reach the provider. Try again.",
  setup_failed: "The connection sandbox could not start. Try again.",
}

/** Keep cleanup on the account that allocated the sandbox, even after a connection changes.
 * Callbacks additionally require that the original compute authority is still active. */
const clientFor = async (
  ctx: AppContext,
  org: string,
  p: PendingLogin,
  requireActive = false,
): Promise<SandboxClient | null> => {
  const { meta, deps } = ctx
  if (p.connection_id) {
    const cn = await runtimeConnection(meta, org)
    const account =
      p.provider === "boat"
        ? p.identity.user_id
        : `${p.identity.organization_id}:${p.identity.user_id}`
    const same =
      cn?.id === p.connection_id && cn.toolkit === p.provider && cn.broker_ref === account
    if (requireActive && (!same || cn?.status !== "active")) return null
    const secret_enc = same ? cn.secret_enc : p.credential_enc
    if (!secret_enc) return null
    return connectionClient(
      { toolkit: p.provider, secret_enc },
      deps.encryptionKey,
      deps.runtimeFetch,
    )
  }
  const config = deps.runtime
  if (
    p.provider !== "ortam" ||
    !config?.managed?.apiKey ||
    p.api_url !== config.apiUrl ||
    (requireActive && !managedFor(config, org))
  )
    return null
  return new OrtamClient(
    config.apiUrl,
    config.managed.apiKey,
    sha256(JSON.stringify([org, "account-login", p.attempt])),
    deps.runtimeFetch,
  )
}

const stopConnection = async (ctx: AppContext, p: PendingLogin, org: string) => {
  if (!p.sandbox_id) return
  const client = await clientFor(ctx, org, p)
  await client?.deleteSandbox(p.sandbox_id, p.attempt, p.identity)
}

export const stopAccountConnection = async (ctx: AppContext, a: AccountRecord) => {
  const p = readPending(a, ctx.deps.encryptionKey)
  if (p) await stopConnection(ctx, p, a.org_id)
}

export const accountLoginRoutes = (ctx: AppContext) => {
  const { meta, deps } = ctx
  const app = new Hono()
  const key = deps.encryptionKey
  const runtime = deps.runtime
  const pending = (a: AccountRecord) => readPending(a, key)
  const available = async (org: string) =>
    !!(key && deps.baseUrl.startsWith("https://") && (await cloudEnabled(meta, runtime, org)))
  const view = (a: AccountRecord) => {
    const p = pending(a)
    return {
      id: a.id,
      status: a.status,
      phase: a.status === "ready" ? "ready" : (p?.phase ?? "failed"),
      verification_url: p?.phase === "awaiting" ? p.verification_url : null,
      user_code: p?.phase === "awaiting" ? p.user_code : null,
      expires_at: p ? new Date(p.expires).toISOString() : null,
      message: p?.reason ? (messages[p.reason] ?? messages.provider_unavailable) : null,
      can_restore: !!p?.previous,
    }
  }
  const save = async (a: AccountRecord, p: PendingLogin, status = a.status) => {
    if (!key) return null
    return meta.updateAccount(
      a.id,
      a.org_id,
      {
        secret_enc: encryptSecret(JSON.stringify(p), key),
        status,
      },
      a.secret_enc,
    )
  }
  const stop = (p: PendingLogin, org: string) => stopConnection(ctx, p, org)
  const owned = async (c: Parameters<typeof ctx.requireWorkspace>[0], id: string) => {
    const org = await ctx.requireWorkspace(c, "publish")
    if (org instanceof Response) return org
    const who = await ctx.managementPrincipal(c)
    if (!who) return fail(c, 403, "A signed-in person connects an account")
    const a = await meta.getAccount(id)
    if (
      !a ||
      a.org_id !== org ||
      !(
        a.user_id === who ||
        (a.user_id === WORKSPACE_ACCOUNT_OWNER && (await ctx.workspaceCan(c, "manage")))
      )
    )
      return fail(c, 404, "Account not found")
    return { a, who, org }
  }

  app.get("/v1/accounts/login-options", async (c) => {
    const org = await ctx.requireWorkspace(c, "read")
    if (org instanceof Response) return org
    return c.json({ device_login: await available(org) })
  })

  app.post("/v1/accounts/login", async (c) => {
    c.header("Cache-Control", "no-store")
    const org = await ctx.requireWorkspace(c, "publish")
    if (org instanceof Response) return org
    const who = await ctx.managementPrincipal(c)
    if (!who) return fail(c, 403, "A signed-in person connects an account")
    if (!key || !(await available(org)))
      return fail(
        c,
        503,
        "Plan connections need cloud compute and a secure callback. Check Settings → Connections or import a login.",
      )
    const b = await readJson(
      c,
      z.object({
        account_id: z.string().optional(),
        name: z.string().trim().max(80).optional(),
        kind: z.enum(["login", "api_key"]).default("login"),
        secret: z.string().trim().min(8).max(20000).optional(),
        shared: z.boolean().default(false),
      }),
    )
    if (b instanceof Response) return b
    if (b.shared && !(await ctx.workspaceCan(c, "manage")))
      return fail(c, 403, "Only a workspace owner shares an account")
    if (b.kind === "api_key" && !b.secret) return fail(c, 400, "Enter your API key")
    if (b.kind === "login" && b.secret) {
      try {
        z.object({ tokens: z.object({ access_token: z.string().min(8) }) }).parse(
          JSON.parse(b.secret),
        )
      } catch {
        return fail(c, 400, "Choose your Codex auth.json file")
      }
    }
    let existing: AccountRecord | null = null
    if (b.account_id) {
      const allowed = await owned(c, b.account_id)
      if (allowed instanceof Response) return allowed
      existing = allowed.a
      if (existing.provider !== "codex") return fail(c, 400, "Choose a Codex account")
      const old = pending(existing)
      if (old && existing.status === "connecting" && old.expires > Date.now())
        return c.json(view(existing), 202)
      if (old) await ctx.afterResponse(c, () => stop(old, org))
    }
    const selected = await workspaceRuntime(meta, runtime, org)
    const attempt = newId("login")
    const box = selected.connection
      ? connectionClient(selected.connection, key, deps.runtimeFetch)
      : new OrtamClient(
          selected.apiUrl,
          runtime?.managed?.apiKey ?? "",
          sha256(JSON.stringify([org, "account-login", attempt])),
          deps.runtimeFetch,
        )
    const p: PendingLogin = {
      attempt,
      owner: who,
      provider: selected.provider,
      api_url: selected.apiUrl,
      ...(selected.connection
        ? {
            connection_id: selected.connection.id,
            credential_enc: selected.connection.secret_enc ?? undefined,
          }
        : {}),
      expires: Date.now() + 600000,
      phase: "starting",
      identity: await box.authenticate(),
      ...(b.secret ? { secret: b.secret } : {}),
      ...(existing?.secret_enc
        ? {
            previous:
              pending(existing)?.previous ??
              (existing.status === "ready" || existing.status === "not_checked"
                ? {
                    secret_enc: existing.secret_enc,
                    kind: existing.kind,
                    status: existing.status,
                    hint: existing.hint,
                  }
                : undefined),
          }
        : {}),
    }
    const a = existing
      ? await meta.updateAccount(
          existing.id,
          org,
          {
            kind: b.kind,
            status: "connecting",
            secret_enc: encryptSecret(JSON.stringify(p), key),
          },
          existing.secret_enc,
        )
      : await meta.createAccount({
          id: newId("acct"),
          org_id: org,
          user_id: b.shared ? WORKSPACE_ACCOUNT_OWNER : who,
          provider: "codex",
          kind: b.kind,
          name: b.name || null,
          status: "connecting",
          secret_enc: encryptSecret(JSON.stringify(p), key),
        })
    if (!a) return fail(c, 409, "This account changed. Open it again.")
    const token = await signCapabilityToken(DOMAIN, key, [a.id, org, p.attempt], p.expires)
    try {
      const created = await box.create(
        {
          name: "Derive model account sign-in",
          size: "small",
          setup_script: `${p.provider === "ortam" ? `${ORTAM_NODE_SETUP}\n` : ""}${ACCOUNT_LOGIN_SETUP}\nnohup node /home/ortam/derive-account-login/connect.mjs >/dev/null 2>&1 </dev/null &`,
          auto_stop_after_seconds: 600,
          env: {
            DERIVE_TOKEN: token,
            DERIVE_ACCOUNT_CALLBACK: `${deps.baseUrl.replace(/\/$/, "")}/v1/accounts/${a.id}/login-callback`,
          },
        },
        p.attempt,
        p.identity,
      )
      // The worker can advance while create returns. Merge its phase through the same CAS.
      for (let retry = 0; retry < 3; retry++) {
        const current = await meta.getAccount(a.id)
        const now = current && pending(current)
        if (current?.status === "ready") {
          await box.deleteSandbox(created.sandbox.id, p.attempt, p.identity)
          return c.json(view(current))
        }
        if (!current || !now || now.attempt !== p.attempt) break
        const updated = await save(current, { ...now, sandbox_id: created.sandbox.id })
        if (!updated) continue
        if (updated.status === "needs_attention")
          await box.deleteSandbox(created.sandbox.id, p.attempt, p.identity)
        return c.json(view(updated), 202)
      }
      await box.deleteSandbox(created.sandbox.id, p.attempt, p.identity)
      return fail(c, 409, "This connection changed. Open it again.")
    } catch {
      await save(
        a,
        { ...p, phase: "failed", reason: "setup_failed", secret: undefined },
        "needs_attention",
      )
      return fail(c, 503, "The connection sandbox could not start. Try again.")
    }
  })

  app.get("/v1/accounts/:id/login", async (c) => {
    c.header("Cache-Control", "no-store")
    const auth = await owned(c, c.req.param("id"))
    if (auth instanceof Response) return auth
    let a = auth.a
    const p = pending(a)
    if (p && a.status === "connecting" && p.expires <= Date.now()) {
      a =
        (await save(
          a,
          { ...p, phase: "failed", reason: "expired", secret: undefined },
          "needs_attention",
        )) ?? a
      await ctx.afterResponse(c, () => stop(p, a.org_id))
    }
    return c.json(view(a))
  })

  app.delete("/v1/accounts/:id/login", async (c) => {
    const auth = await owned(c, c.req.param("id"))
    if (auth instanceof Response) return auth
    const p = pending(auth.a)
    if (!p) return c.json({ cancelled: false })
    const changed = await meta.updateAccount(
      auth.a.id,
      auth.org,
      p.previous ?? {
        status: "needs_attention",
        secret_enc: null,
        hint: "Connection cancelled",
      },
      auth.a.secret_enc,
    )
    if (!changed) return fail(c, 409, "This account changed. Open it again.")
    await ctx.afterResponse(c, () => stop(p, auth.org))
    return c.json({ cancelled: true })
  })

  // authz-exempt: an expiring capability reaches only this attempt's credential handoff.
  app.all("/v1/accounts/:id/login-callback", async (c) => {
    c.header("Cache-Control", "no-store")
    if (!key || !["GET", "POST"].includes(c.req.method)) return fail(c, 403, "Forbidden")
    const token = c.req.header("Authorization")?.replace(/^Bearer /, "") ?? ""
    const claim = await verifyCapabilityToken(DOMAIN, key, token, Date.now())
    const a = await meta.getAccount(c.req.param("id"))
    const p = a && pending(a)
    const client = a && p && (await clientFor(ctx, a.org_id, p, true))
    if (
      !a ||
      !p ||
      a.status !== "connecting" ||
      !client ||
      claim?.rest !== [a.id, a.org_id, p.attempt].join(".") ||
      !(await hasSeat(meta, a.org_id, p.owner))
    )
      return fail(c, 403, "This connection ended")
    if (c.req.method === "GET") return c.json({ kind: a.kind, secret: p.secret ?? null })
    const b = await readJson(
      c,
      z.discriminatedUnion("phase", [
        z.object({
          phase: z.literal("awaiting"),
          verification_url: z.literal("https://auth.openai.com/codex/device"),
          user_code: z.string().regex(/^[A-Z0-9-]{4,20}$/),
        }),
        z.object({ phase: z.literal("checking") }),
        z.object({
          phase: z.literal("ready"),
          kind: z.enum(["login", "api_key"]),
          secret: z.string().min(8).max(20000),
        }),
        z.object({
          phase: z.literal("failed"),
          reason: z.enum([
            "expired",
            "approval_failed",
            "check_timed_out",
            "access_failed",
            "memory_required",
            "provider_unavailable",
          ]),
        }),
      ]),
    )
    if (b instanceof Response) return b
    if (b.phase === "ready") {
      if (p.phase !== "checking" || b.kind !== a.kind) return fail(c, 409, "Access was not checked")
      if (b.kind === "login") {
        try {
          z.object({ tokens: z.object({ access_token: z.string().min(8) }) }).parse(
            JSON.parse(b.secret),
          )
        } catch {
          return fail(c, 400, "Invalid login")
        }
      }
      const done = await meta.updateAccount(
        a.id,
        a.org_id,
        {
          secret_enc: encryptSecret(b.secret, key),
          status: "ready",
          hint: "Access checked",
        },
        a.secret_enc,
      )
      if (!done) return fail(c, 409, "This connection changed")
      await ctx.afterResponse(c, () => stop(p, a.org_id))
    } else {
      if (b.phase === "awaiting" && p.phase !== "starting")
        return fail(c, 409, "This connection changed")
      if (b.phase === "checking" && !["starting", "awaiting"].includes(p.phase))
        return fail(c, 409, "This connection changed")
      const changed = await save(
        a,
        {
          ...p,
          ...b,
          ...(b.phase === "failed" ? { secret: undefined, user_code: undefined } : {}),
        },
        b.phase === "failed" ? "needs_attention" : "connecting",
      )
      if (!changed) return fail(c, 409, "This connection changed")
      if (b.phase === "failed") await ctx.afterResponse(c, () => stop(p, a.org_id))
    }
    return c.json({ accepted: true })
  })
  return app
}

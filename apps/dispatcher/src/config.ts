// The dispatcher's whole configuration is environment plus one JSON registry —
// 12-factor, exactly like the runner it schedules. The registry names WHICH
// contexts this dispatcher serves; everything about HOW a drain runs stays in
// the runner's own env contract (RUNNER_*, model credential).
//
// Registry sources: DISPATCHER_CONTEXTS (inline JSON) or DISPATCHER_CONTEXTS_FILE
// (a path). Shape: [{ "id": "ctx_…", "token_env": "CTX_A_TOKEN" }] or the same
// list under { "contexts": [...] }. Tokens are never inline in the registry —
// each entry names token_env (an env var) or token_file (a path), the same
// no-embedded-secrets discipline `runner install` enforces for service units.
import { readFileSync } from "node:fs"

export type ManagedContext = {
  id: string
  tokenEnv: string | null
  tokenFile: string | null
  model: string | null
  cron: string
}

export type DispatcherConfig = {
  databaseUrl: string
  server: string
  runnerBin: string
  dataDir: string
  drainTimeoutMs: number
  contexts: ManagedContext[]
}

// Per-minute: the pull cadence until the webhook kick lands. pg-boss cron is
// minute-granular, which is exactly the latency the plan accepts for v1.
const CRON_DEFAULT = "* * * * *"

const positiveMs = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const parseContext = (c: unknown, i: number): ManagedContext => {
  if (typeof c !== "object" || c === null) throw new Error(`contexts[${i}] must be an object`)
  const o = c as Record<string, unknown>
  if (typeof o.id !== "string" || !o.id) throw new Error(`contexts[${i}] is missing "id"`)
  if (o.token !== undefined)
    throw new Error(
      `contexts[${i}] ("${o.id}") embeds a token — the registry never holds secrets; name a "token_env" or "token_file" instead`,
    )
  const tokenEnv = typeof o.token_env === "string" && o.token_env ? o.token_env : null
  const tokenFile = typeof o.token_file === "string" && o.token_file ? o.token_file : null
  if (!tokenEnv && !tokenFile)
    throw new Error(`contexts[${i}] ("${o.id}") needs "token_env" or "token_file"`)
  const cron = typeof o.cron === "string" && o.cron ? o.cron : CRON_DEFAULT
  if (cron.trim().split(/\s+/).length !== 5)
    throw new Error(`contexts[${i}] ("${o.id}") cron "${cron}" is not a 5-field cron expression`)
  return {
    id: o.id,
    tokenEnv,
    tokenFile,
    model: typeof o.model === "string" && o.model ? o.model : null,
    cron,
  }
}

export function loadDispatcherConfig(env: NodeJS.ProcessEnv = process.env): DispatcherConfig {
  const databaseUrl = env.DATABASE_URL ?? ""
  if (!databaseUrl) throw new Error("DATABASE_URL is required (pg-boss keeps its jobs in Postgres)")
  const raw =
    env.DISPATCHER_CONTEXTS ??
    (env.DISPATCHER_CONTEXTS_FILE ? readFileSync(env.DISPATCHER_CONTEXTS_FILE, "utf8") : "")
  if (!raw)
    throw new Error("DISPATCHER_CONTEXTS (inline JSON) or DISPATCHER_CONTEXTS_FILE is required")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`contexts registry is not valid JSON: ${(e as Error).message}`)
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { contexts?: unknown }).contexts
  if (!Array.isArray(list) || list.length === 0)
    throw new Error('contexts registry must be a non-empty list (or { "contexts": [...] })')
  const contexts = list.map(parseContext)
  const dupe = contexts.find((c, i) => contexts.findIndex((d) => d.id === c.id) !== i)
  if (dupe) throw new Error(`context "${dupe.id}" appears twice in the registry`)
  return {
    databaseUrl,
    // Cloud default, like every other piece of the CLI family.
    server: (env.DERIVE_SERVER ?? "https://derive.to").replace(/\/+$/, ""),
    runnerBin: env.DISPATCHER_RUNNER_BIN ?? "derive",
    dataDir: env.DISPATCHER_DATA_DIR ?? "/data",
    // Runner default timeout (10 min) plus a boot margin; the drain is killed
    // past this, and pg-boss's retry takes it from there.
    drainTimeoutMs: positiveMs(env.DISPATCHER_DRAIN_TIMEOUT_MS, 660_000),
    contexts,
  }
}

/** Resolve one context's agent token from the source its registry entry names.
 *  Called for every context at boot on purpose: a misnamed env var should fail
 *  the deploy, not the 3am drain. */
export function resolveToken(ctx: ManagedContext, env: NodeJS.ProcessEnv): string {
  if (ctx.tokenEnv) {
    const t = (env[ctx.tokenEnv] ?? "").trim()
    if (!t) throw new Error(`context "${ctx.id}": env var ${ctx.tokenEnv} is empty or unset`)
    return t
  }
  const t = readFileSync(ctx.tokenFile as string, "utf8").replace(/\s+/g, "")
  if (!t) throw new Error(`context "${ctx.id}": token file ${ctx.tokenFile} is empty`)
  return t
}

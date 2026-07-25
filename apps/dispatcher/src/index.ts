// The managed executor: a plain clock that drains OWNER-run contexts via `derive runner once`,
// plus — when the hosted lane is configured — an internal HTTP surface (WP3) that runs SHARED
// hosted agents live. The Derive API, the model, and the answer contract live in the runner and
// the hosted-agent harness; the dispatcher owns scheduling + process lifecycle only.
//
// No job system. This used to run pg-boss, but everything it provided here is a few lines of
// what we already had: the clock is a cron evaluation (croner), "at most one drain per context"
// is an in-flight flag, and the retry is simply the next tick — a drain reads the WHOLE queue
// every time, so a missed one costs latency, never work. Dropping it also drops a hard Postgres
// dependency from a process whose only state is "am I mid-drain", and removes the second
// queue-of-record that would otherwise sit beside Derive's own run table.
import { serve } from "@hono/node-server"
import { Cron } from "croner"
import { loadDispatcherConfig, type ManagedContext, resolveToken } from "./config"
import { runDrain } from "./drain"
import type { ModelResolver } from "./invoke"
import { buildServer } from "./server"

// The model is wired by the host, never by the harness (Q4 neutrality). Until a
// provider is configured, the hosted lane accepts requests but fails the run
// with a clear message rather than pretending to be ready.
const resolveModel: ModelResolver = () => {
  throw new Error(
    "no model provider configured for the hosted lane — set one up in the host (e.g. an @ai-sdk provider) and wire resolveModel",
  )
}

async function main() {
  const cfg = loadDispatcherConfig()
  // Resolve every token at boot on purpose: a misnamed env var or empty token
  // file fails the deploy loudly instead of failing the 3am drain quietly.
  const tokens = new Map(cfg.contexts.map((c) => [c.id, resolveToken(c, process.env)]))

  /** One drain, guarded so a tick landing mid-drain is DROPPED, not queued behind it — the
   *  next tick covers whatever arrived, because a drain reads the whole queue every time. */
  const inFlight = new Set<string>()
  const drainOnce = async (ctx: ManagedContext, token: string): Promise<void> => {
    if (inFlight.has(ctx.id)) return
    inFlight.add(ctx.id)
    try {
      const r = await runDrain(cfg, ctx, token)
      const line = `[dispatcher] ${ctx.id} drain ${r.ok ? "ok" : `FAILED (code ${r.code}${r.signal ? `, ${r.signal}` : ""})`} in ${r.ms}ms`
      if (r.ok) console.log(line)
      // A failed drain is logged with its tail and left for the next tick. There is nothing to
      // "retry" beyond running again, which the schedule already does.
      else console.error(`${line}\n${r.tail}`)
    } catch (e) {
      console.error(`[dispatcher] ${ctx.id} drain error: ${(e as Error).message}`)
    } finally {
      inFlight.delete(ctx.id)
    }
  }

  const jobs: Cron[] = []
  for (const ctx of cfg.contexts) {
    const token = tokens.get(ctx.id)
    if (!token) throw new Error(`no token resolved for ${ctx.id}`)
    jobs.push(new Cron(ctx.cron, () => void drainOnce(ctx, token)))
    // One immediate drain at boot: a restart catches up on whatever queued while the
    // dispatcher was down, instead of waiting out the first tick.
    void drainOnce(ctx, token)
    console.log(`[dispatcher] scheduled ${ctx.id} (${ctx.cron})`)
  }

  // The hosted-lane HTTP surface, only when a secret is configured — a self-host
  // without the shared lane runs the context clock alone.
  let httpServer: ReturnType<typeof serve> | undefined
  if (cfg.hostSecret) {
    httpServer = serve({ fetch: buildServer({ cfg, resolveModel }).fetch, port: cfg.httpPort })
    console.log(`[dispatcher] hosted-lane HTTP surface on :${cfg.httpPort}`)
  }

  const stop = () => {
    httpServer?.close()
    for (const j of jobs) j.stop()
    process.exit(0)
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  console.log(
    `[dispatcher] serving ${cfg.contexts.length} context(s) against ${cfg.server} — runner: ${cfg.runnerBin}`,
  )
}

main().catch((e: Error) => {
  // Startup failures get the house one-liner, not a stack trace — same
  // convention as the runner CLI.
  console.error(`error: ${e.message}`)
  process.exit(1)
})

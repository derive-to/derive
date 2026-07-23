// The managed executor from the built-in agent plan: pg-boss (cron + retries +
// singleton-per-queue, all in Postgres) drains OWNER-run contexts via `derive
// runner once`, and — when the hosted lane is configured — an internal HTTP
// surface (WP3) runs SHARED hosted agents live. The Derive API, the model, and
// the answer contract live in the runner and the hosted-agent harness; the
// dispatcher owns scheduling + process lifecycle only.
import { serve } from "@hono/node-server"
import PgBoss from "pg-boss"
import { loadDispatcherConfig, resolveToken } from "./config"
import { runDrain } from "./drain"
import type { ModelResolver } from "./invoke"
import { buildServer } from "./server"

const queueFor = (id: string) => `drain:${id}`

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
  const boss = new PgBoss(cfg.databaseUrl)
  boss.on("error", (err) => console.error(`[dispatcher] pg-boss: ${err.message}`))
  await boss.start()

  for (const ctx of cfg.contexts) {
    const queue = queueFor(ctx.id)
    const token = tokens.get(ctx.id)
    if (!token) throw new Error(`no token resolved for ${ctx.id}`)
    // singleton: at most one drain per context in flight. A cron tick that
    // lands mid-drain is dropped, not queued behind it — the next tick covers
    // whatever arrived, because the runner drains the whole queue every run.
    await boss.createQueue(queue, { name: queue, policy: "singleton" })
    await boss.schedule(queue, ctx.cron, {}, { retryLimit: 2, retryDelay: 60 })
    // One immediate drain at boot: a restart catches up on whatever queued
    // while the dispatcher was down, instead of waiting out the first tick.
    await boss.send(queue, {}, { retryLimit: 2, retryDelay: 60 })
    await boss.work(queue, async () => {
      const r = await runDrain(cfg, ctx, token)
      const line = `[dispatcher] ${ctx.id} drain ${r.ok ? "ok" : `FAILED (code ${r.code}${r.signal ? `, ${r.signal}` : ""})`} in ${r.ms}ms`
      if (r.ok) {
        console.log(line)
        return
      }
      console.error(`${line}\n${r.tail}`)
      // Throwing hands the failure to pg-boss: retryLimit/retryDelay from the
      // schedule above, and the job row keeps the tail for postmortems.
      throw new Error(`drain failed: ${r.tail.slice(-300)}`)
    })
    console.log(`[dispatcher] scheduled ${ctx.id} (${ctx.cron})`)
  }

  // The hosted-lane HTTP surface, only when a secret is configured — self-host
  // without the shared lane runs pg-boss alone.
  let httpServer: ReturnType<typeof serve> | undefined
  if (cfg.hostSecret) {
    httpServer = serve({ fetch: buildServer({ cfg, resolveModel }).fetch, port: cfg.httpPort })
    console.log(`[dispatcher] hosted-lane HTTP surface on :${cfg.httpPort}`)
  }

  const stop = async () => {
    httpServer?.close()
    await boss.stop()
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

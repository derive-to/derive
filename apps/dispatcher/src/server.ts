import { Hono } from "hono"
import type { DispatcherConfig } from "./config"
import { type InvokeRequest, invokeHostedAgent, type ModelResolver } from "./invoke"

// WP3: the agent host's internal HTTP surface. The API reaches it over a shared
// secret to run a shared-lane hosted agent live (Draft with your agent, an
// @mention reply). Internal-only: never exposed publicly, so the secret is the
// whole auth story. Health is unauthenticated for liveness probes.

const bad = (msg: string, status: 400 | 401 | 500) => ({ error: msg, status })

/** Parse + validate an invoke body; returns the request or a message. */
export function parseInvoke(body: unknown): InvokeRequest | string {
  if (typeof body !== "object" || body === null) return "body must be an object"
  const b = body as Record<string, unknown>
  const str = (k: string) => (typeof b[k] === "string" && b[k] ? (b[k] as string) : null)
  const agentToken = str("agentToken")
  const manifest = str("manifest")
  const task = str("task")
  const trigger = str("trigger")
  if (!agentToken) return "agentToken is required"
  if (!manifest) return "manifest is required"
  if (!task) return "task is required"
  if (!trigger) return "trigger is required"
  const autonomy = b.autonomy
  if (autonomy !== "shadow" && autonomy !== "suggest" && autonomy !== "auto")
    return "autonomy must be shadow | suggest | auto"
  const flags = b.flags as Record<string, unknown> | undefined
  if (
    !flags ||
    typeof flags.agentKillswitch !== "boolean" ||
    typeof flags.agentAutoEnabled !== "boolean"
  )
    return "flags.agentKillswitch and flags.agentAutoEnabled (booleans) are required"
  return {
    agentToken,
    manifest,
    task,
    trigger,
    conventions: str("conventions") ?? undefined,
    autonomy,
    flags: { agentKillswitch: flags.agentKillswitch, agentAutoEnabled: flags.agentAutoEnabled },
  }
}

export interface ServerDeps {
  cfg: DispatcherConfig
  resolveModel: ModelResolver
  /** Injectable for tests; defaults to the real Mastra invoke. */
  invoke?: typeof invokeHostedAgent
}

export function buildServer(deps: ServerDeps): Hono {
  const app = new Hono()
  const secret = deps.cfg.hostSecret

  app.get("/internal/health", (c) => c.json({ ok: true }))

  // Constant-shape auth: a single shared secret in a header. Timing-safe compare
  // isn't warranted (the secret is high-entropy and this surface is internal,
  // not public), but a missing secret config fails every call closed.
  app.use("/internal/invoke", async (c, next) => {
    if (!secret) return c.json(bad("hosted lane not configured", 500), 500)
    if (c.req.header("x-derive-host-secret") !== secret)
      return c.json(bad("unauthorized", 401), 401)
    await next()
  })

  app.post("/internal/invoke", async (c) => {
    const parsed = parseInvoke(await c.req.json().catch(() => null))
    if (typeof parsed === "string") return c.json(bad(parsed, 400), 400)
    try {
      const result = await (deps.invoke ?? invokeHostedAgent)(
        { server: deps.cfg.server, resolveModel: deps.resolveModel },
        parsed,
      )
      return c.json(result)
    } catch (e) {
      return c.json(bad(`invoke failed: ${(e as Error).message}`, 500), 500)
    }
  })

  return app
}

import { Hono } from "hono"
import { capabilityReport } from "../config-manifest"
import type { AppContext } from "../context"
import { fail } from "../lib/http"
import { log } from "../log"

/** Operational endpoints: liveness (/healthz), readiness (/readyz — proves the datastore
 *  and blob store are reachable), and the minimal API-origin landing page. */
export const systemRoutes = (ctx: AppContext) => {
  const { deps, meta, blobs, isToken, isSuperAdmin } = ctx
  const app = new Hono()

  app.get("/healthz", (c) => c.json({ ok: true }))

  // Readiness (vs /healthz liveness): proves the datastore + blob store are
  // actually reachable, so an orchestrator stops routing to an instance whose DB
  // or blob backend is down instead of letting it 500 every request. 503 on any
  // failure. Point the platform healthcheck here for rollout/traffic gating.
  app.get("/readyz", async (c) => {
    try {
      await meta.getWorkspace(deps.defaultOrgId ?? "default")
      // A valid 64-hex key so the store does real I/O (fs read / S3 GET): the
      // sentinel doesn't exist, so a healthy backend returns null, but an
      // unreachable one throws — which is the signal we want. A non-hex key
      // would short-circuit to null without touching the backend (no-op probe).
      await blobs.get("0".repeat(64))
      return c.json({ ok: true })
    } catch (err) {
      log.error("readiness check failed", {
        error: err instanceof Error ? err.message : String(err),
      })
      return c.json({ ok: false }, 503)
    }
  })

  // Operator-only config introspection for `derive doctor`: which optional features are
  // on / off / half-configured, plus the env vars still missing (names only, never secret
  // values). process.env carries the vars on both runtimes (nodejs_compat populate).
  app.get("/v1/system/capabilities", async (c) => {
    if (!isToken(c) && !(await isSuperAdmin(c)))
      return fail(c, 403, "operator access required (DERIVE_TOKEN or a super-admin account)")
    // Email's transport is runtime-specific: Resend on Node, but the Cloudflare Email
    // Service binding (NOT a process.env var) on the edge. So its true on/off is the app's
    // already-resolved `emailEnabled`, not a guess from RESEND_API_KEY (unset on the edge).
    // The other capabilities are gated on secrets that populate_process_env mirrors on both.
    const capabilities = capabilityReport(process.env).map((cap) =>
      cap.id === "email" && deps.emailEnabled
        ? { ...cap, status: "on" as const, missing: [] }
        : cap,
    )
    return c.json({ capabilities })
  })

  // A minimal API-origin landing. Skipped when the SPA is bundled in-process
  // (serveWeb) so the app's own home page owns `/`.
  if (!deps.serveWeb)
    app.get("/", (c) =>
      c.html(
        `<!doctype html><meta charset="utf-8"><title>Derive</title>
<body style="font:16px/1.6 system-ui;background:#f6f0e3;color:#2a2540;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="letter-spacing:-.02em">Derive</h1>
<p>An open home for AI-generated artifacts.<br>
<code style="background:#eee7d6;padding:2px 8px;border-radius:6px">derive publish ./your-thing</code></p></div>`,
      ),
    )

  return app
}

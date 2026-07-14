import { z } from "@hono/zod-openapi"
import { Hono } from "hono"
import { capabilityReport } from "../config-manifest"
import type { AppContext } from "../context"
import { fail, readJson } from "../lib/http"
import { reindexSearchBatch } from "../lib/search"
import { log } from "../log"

/** Operational endpoints: liveness (/healthz), readiness (/readyz — proves the datastore
 *  and blob store are reachable), and the minimal API-origin landing page. */
export const systemRoutes = (ctx: AppContext) => {
  const { deps, meta, blobs, search, isToken, isSuperAdmin } = ctx
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

  // Backfill the workspace search index over the EXISTING corpus. Publishing keeps the
  // index current going forward (emitVersionBump), but artifacts published before that
  // wiring — or created outside it — need a one-time sweep. Operator-only, idempotent,
  // and bounded: it indexes one page (default 100, max 200) and returns `nextCursor`;
  // the operator re-POSTs with that cursor until it comes back null. The cap stays modest
  // because a bundle indexes every page it holds — a bundle-dense page of 500 could breach
  // the Worker's per-invocation subrequest ceiling, which the per-artifact try/catch would
  // silently swallow as "skipped." Keeping each call bounded is what fits the Workers CPU +
  // subrequest budget rather than one unbounded pass. Run it as
  // a one-time backfill: under a concurrent live publish it could momentarily write
  // older-version text for that artifact, but grep-confirm reads the live blob (so
  // precision holds) and the next publish re-indexes it — the staleness self-heals.
  //   curl -XPOST -H "authorization: Bearer $DERIVE_TOKEN" .../v1/system/search-reindex
  //   # then repeat, passing {"cursor": <nextCursor>} until nextCursor is null
  app.post("/v1/system/search-reindex", async (c) => {
    if (!isToken(c) && !(await isSuperAdmin(c)))
      return fail(c, 403, "operator access required (DERIVE_TOKEN or a super-admin account)")
    const body = await readJson(
      c,
      z.object({
        orgId: z.string().optional(),
        // `.nullish()`: the natural resume loop echoes back the previous `nextCursor`, which is
        // literally `null` on the final page — accept it as "start from the top" rather than 400.
        cursor: z.object({ created_at: z.string(), id: z.string() }).nullish(),
        limit: z.number().int().optional(),
      }),
    )
    if (body instanceof Response) return body
    const limit = Math.min(Math.max(body.limit ?? 100, 1), 200)
    const result = await reindexSearchBatch(
      { meta, blobs, search },
      // Normalize null→undefined: reindexSearchBatch's keyset cursor is `{…} | undefined`.
      { orgId: body.orgId, cursor: body.cursor ?? undefined, limit },
    )
    return c.json(result)
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

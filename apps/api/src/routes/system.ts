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

  // Liveness, plus the commit actually serving. `build` is what makes a silent non-deploy
  // detectable without Cloudflare credentials or CI access: curl it and compare. Deliberately
  // on the UNAUTHENTICATED liveness route — the audience is a deploy check and an operator
  // asking "did my change ship", and a commit sha discloses nothing a public repo does not.
  app.get("/healthz", (c) => c.json({ ok: true, build: deps.buildId ?? "dev" }))

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

  // TEMPORARY DIAGNOSTIC — remove before merge. Times the model gateway with a RAW fetch,
  // no AI SDK in the path, so "is the provider slow" can be answered without inferring it
  // from a turn that also builds tools, reads the store and streams deltas. Reports timing
  // and status only; never the key, and it writes nothing.
  app.get("/v1/system/model-probe", async (c) => {
    if (!isToken(c) && !(await isSuperAdmin(c)))
      return fail(c, 403, "operator access required (DERIVE_TOKEN or a super-admin account)")
    const base = process.env.DERIVE_MODEL_BASE_URL?.replace(/\/+$/, "")
    const key = process.env.DERIVE_MODEL_API_KEY
    const model = process.env.DERIVE_MODEL_NAME
    if (!base || !key || !model) return c.json({ configured: false, base: !!base, model })
    const stream = c.req.query("stream") === "1"
    const started = Date.now()
    try {
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "say hi in three words" }],
          max_tokens: 16,
          ...(stream ? { stream: true } : {}),
        }),
        signal: AbortSignal.timeout(60_000),
      })
      const headersAt = Date.now() - started
      const body = await r.text()
      return c.json({
        configured: true,
        model,
        stream,
        status: r.status,
        ms_to_headers: headersAt,
        ms_total: Date.now() - started,
        body: body.slice(0, 400),
      })
    } catch (e) {
      return c.json({
        configured: true,
        model,
        stream,
        ms_total: Date.now() - started,
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      })
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
    const capabilities = capabilityReport(process.env).map((cap) => {
      // Email's true on/off is the resolved transport, not an env guess (see below).
      if (cap.id === "email" && deps.emailEnabled)
        return { ...cap, status: "on" as const, missing: [] }
      // Semantic search's true on/off is whether the dense arm actually got wired: the embedder
      // vars alone report "on", but the arm needs Postgres (pgvector) and a working setup, so on
      // SQLite — or when dense setup failed — `search` is undefined and it's really off.
      if (cap.id === "semanticSearch")
        return search
          ? { ...cap, status: "on" as const, missing: [] }
          : { ...cap, status: "off" as const }
      return cap
    })
    return c.json({ capabilities })
  })

  // Backfill the workspace search index over the EXISTING corpus. Publishing keeps the
  // index current going forward (emitVersionBump), but artifacts published before that
  // wiring — or created outside it — need a one-time sweep. Operator-only, idempotent,
  // and bounded: it indexes one page (default 100, max 200) and returns `nextCursor`;
  // the operator re-POSTs with that cursor until it comes back null. The cap stays modest
  // because it reads every page a bundle holds. The dense arm now embeds + upserts in BATCHES (few
  // subrequests), so the per-invocation budget is dominated by the LEXICAL arm's per-artifact blob
  // read + D1 write; keeping `limit` ≤ 200 holds that under the Worker's subrequest ceiling. Two
  // failure modes to know: (1) one artifact's lexical index fails (e.g. an unreadable blob) — caught
  // per-artifact, and `indexed < scanned` flags it, so re-sweep from cursor 0 (idempotent) to catch
  // it; (2) the whole dense BATCH fails — best-effort, swallowed after the loop, so it does NOT lower
  // `indexed`; if the dense arm was down for a page, re-sweep from cursor 0. Keeping each call
  // bounded fits the Workers CPU + subrequest budget rather than one unbounded pass. Run it as
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
        cursor: z.object({ key: z.string(), id: z.string() }).nullish(),
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

  // A minimal API-origin landing, ONLY for deployments with no SPA at all. Skipped
  // when the SPA is bundled in-process (serveWeb, the Node tier) AND when a shell
  // provider exists (the edge Worker, where `/` is routed worker-first and
  // routes/marketing.ts owns it — this placeholder would shadow the real home page).
  if (!deps.serveWeb && !deps.shell && !deps.shellFetch)
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

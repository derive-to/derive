import { z } from "@hono/zod-openapi"
import { Hono } from "hono"
import { capabilityReport } from "../config-manifest"
import type { AppContext } from "../context"
import { fail, readJson } from "../lib/http"
import { getInstanceChatModel, setInstanceChatModel } from "../lib/instance-settings"
import { reindexSearchBatch } from "../lib/search"
import {
  BACKFILL_DEFAULT_LIMIT,
  BACKFILL_MAX_LIMIT,
  backfillSummaryBatch,
} from "../lib/summary-backfill"
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

  // THE DEPLOY-WIDE MODEL, read and set by the operator.
  //
  // Not a workspace setting: the operator holds the model credential and pays for every turn on
  // it, and when a provider goes slow or dark the person who has to move everyone at once is the
  // one who runs the instance. Read fresh per turn, so a change lands on the next message rather
  // than the next deploy.
  app.get("/v1/system/chat-model", async (c) => {
    if (!isToken(c) && !(await isSuperAdmin(c)))
      return fail(c, 403, "operator access required (DERIVE_TOKEN or a super-admin account)")
    return c.json({
      model: await getInstanceChatModel(meta),
      // The catalog travels with it so the picker needs one call, and so "what is set" and "what
      // could be set" can never disagree about which ids exist.
      options: (ctx.models?.options ?? []).map((m) => ({
        id: m.id,
        label: m.label,
        is_default: m.isDefault,
      })),
    })
  })

  app.put("/v1/system/chat-model", async (c) => {
    if (!isToken(c) && !(await isSuperAdmin(c)))
      return fail(c, 403, "operator access required (DERIVE_TOKEN or a super-admin account)")
    const b = await readJson(c, z.object({ model: z.string().nullable() }))
    if (b instanceof Response) return b
    // Validated against the catalog, so a typo is refused HERE where somebody is looking at the
    // response rather than silently costing every turn on the deploy.
    if (b.model && !ctx.models?.resolve(b.model)) return fail(c, 400, `unknown model "${b.model}"`)
    await setInstanceChatModel(meta, b.model)
    return c.json({ model: await getInstanceChatModel(meta) })
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

  // Backfill the one-line summary every unfurl surface describes an artifact with, over the
  // EXISTING corpus. Publishing keeps it current going forward (lib/after-publish.ts); this
  // closes the gap for artifacts published before that wiring. Same operator loop as
  // search-reindex above — re-POST with `nextCursor` until it comes back null:
  //   curl -XPOST -H "authorization: Bearer $DERIVE_TOKEN" .../v1/system/summary-backfill
  //   # then repeat, passing {"cursor": <nextCursor>} until nextCursor is null
  //
  // Pages are far smaller than the reindex sweep's (25 vs 100) because the per-artifact work is
  // a MODEL CALL rather than a blob read, so wall time — not the subrequest ceiling — is what
  // bounds a page. Idempotent: an artifact that already has a summary costs one read, so a
  // partial sweep can be resumed from cursor 0 rather than tracked.
  //
  // 404 rather than a no-op when no model is bound: on a deploy without one there is nothing
  // this could ever do, and a silent 200 reporting "0 attempted" reads like an empty corpus.
  app.post("/v1/system/summary-backfill", async (c) => {
    if (!isToken(c) && !(await isSuperAdmin(c)))
      return fail(c, 403, "operator access required (DERIVE_TOKEN or a super-admin account)")
    if (!deps.summarize)
      return fail(c, 404, "no summarizer is configured on this deployment (needs the AI binding)")
    const body = await readJson(
      c,
      z.object({
        orgId: z.string().optional(),
        // `.nullish()` for the same reason as search-reindex: the natural resume loop echoes back
        // the previous `nextCursor`, which is literally null on the final page.
        cursor: z.object({ key: z.string(), id: z.string() }).nullish(),
        limit: z.number().int().optional(),
      }),
    )
    if (body instanceof Response) return body
    const limit = Math.min(Math.max(body.limit ?? BACKFILL_DEFAULT_LIMIT, 1), BACKFILL_MAX_LIMIT)
    return c.json(
      await backfillSummaryBatch(
        { meta, blobs, summarize: deps.summarize },
        { orgId: body.orgId, cursor: body.cursor ?? undefined, limit },
      ),
    )
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

import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { readJson } from "../lib/http"
import { log } from "../log"

/** Core Web Vitals collector: the SPA beacons real field metrics here (LCP / INP
 *  / CLS / TTFB), so production performance is measured from actual users instead
 *  of guessed at. We only structure-log them (one line per metric) — a log
 *  pipeline can aggregate p75s — so there's no datastore write and nothing to
 *  brute force; the global per-IP /v1 write limiter is the only backstop needed. */
export const vitalsRoutes = (_ctx: AppContext) => {
  const app = new Hono()

  // A real user's browser, signed in or not, reports its vitals — so this is
  // anonymous by design (it's allow-listed in the anon-write lockdown). The body
  // is the web-vitals Metric shape the SPA sends; sendBeacon can't read the
  // response, so we just accept and 204.
  // authz-exempt: anonymous client performance telemetry — no identity, no state mutated.
  app.post("/v1/vitals", async (c) => {
    const b = await readJson(
      c,
      z.object({
        name: z.enum(["LCP", "INP", "CLS", "TTFB", "FCP"]),
        value: z.number().finite(),
        rating: z.enum(["good", "needs-improvement", "poor"]),
        id: z.string().max(120),
        path: z.string().max(512),
      }),
    )
    if (b instanceof Response) return b
    // Raw value (not rounded): CLS is a 0–1 float that rounding would flatten to
    // 0, while LCP/INP/TTFB are already ms. The log pipeline aggregates p75s.
    log.info("web-vital", { metric: b.name, value: b.value, rating: b.rating, path: b.path })
    return c.body(null, 204)
  })

  return app
}

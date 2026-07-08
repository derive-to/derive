import { expect, it } from "vitest"
import { anonApp } from "./helpers"

// The OpenAPI document is GENERATED from the contract-first routes (the ones using
// createRoute) — a single source that also generates the web client's response types
// (apps/web/src/api-types.ts via `pnpm --filter @derive/web gen:api-types`). This test
// locks it: change a migrated route's shape and this snapshot fails until you regenerate
// (`pnpm --filter @derive/api gen:openapi`), which then regenerates the web types and
// breaks any stale web code at `tsc`. Drift becomes a failing check, never a silent
// backend/web mismatch. Mirrors the gen:d1-schema discipline in packages/db.
it("serves an OpenAPI document that matches the committed snapshot", async () => {
  const res = await anonApp.request("/openapi.json")
  expect(res.status).toBe(200)
  const spec = (await res.json()) as {
    paths: Record<string, unknown>
    components: { schemas: Record<string, unknown> }
  }

  // follows is the first migrated router. Asserting it's present guards the sub-app →
  // parent spec merge — the mechanism that lets routers migrate one at a time.
  expect(spec.paths["/v1/follows"]).toBeDefined()
  expect(spec.components.schemas.Follow).toBeDefined()

  await expect(`${JSON.stringify(spec, null, 2)}\n`).toMatchFileSnapshot("../openapi.json")
})

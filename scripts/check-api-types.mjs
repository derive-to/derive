#!/usr/bin/env node
// apps/web/src/api-types.ts is GENERATED from apps/api/openapi.json by openapi-typescript
// (`pnpm --filter @derive/web gen:api-types`). This guards it: if the spec changed but the
// types weren't regenerated, the web client would silently drift from the backend contract.
// Regenerate to a temp file and compare; a mismatch fails `pnpm run ci`.
//
// This is the SECOND of three links in the chain, and it is worth knowing what each one
// actually proves. backend route → OpenAPI spec is a ratchet, not a guarantee:
// apps/api/test/route-coverage.test.ts snapshots the mounted routes the spec omits, so the
// omission is visible in review, but a route added without `createRoute` is still absent
// from the spec by design while routers migrate one at a time. OpenAPI spec → web types is
// this check, and it IS exact. The spec's own content is snapshot-locked by
// apps/api/test/openapi.test.ts. So: types never drift from the spec, and the spec's
// coverage of the routes only moves in one direction.
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const OUT = "apps/web/src/api-types.ts"
const tmp = join(mkdtempSync(join(tmpdir(), "derive-api-types-")), "api-types.ts")

// openapi-typescript's binary lives in the web workspace; run it there (cwd = apps/web) so
// the schema path is relative to that package, matching the gen:api-types script.
try {
  execFileSync(
    "pnpm",
    ["--filter", "@derive/web", "exec", "openapi-typescript", "../api/openapi.json", "-o", tmp],
    { stdio: "pipe" },
  )
} catch (err) {
  console.error("check-api-types: failed to regenerate types —", err.message)
  process.exit(1)
}

if (readFileSync(tmp, "utf8") !== readFileSync(OUT, "utf8")) {
  console.error(
    `check-api-types: ${OUT} is stale vs apps/api/openapi.json.\n` +
      "  The OpenAPI spec changed but the web types weren't regenerated.\n" +
      "  Fix: pnpm --filter @derive/web gen:api-types",
  )
  process.exit(1)
}
console.log("check-api-types: ok — web types match the OpenAPI spec")

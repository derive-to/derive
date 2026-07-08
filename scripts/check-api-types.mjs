#!/usr/bin/env node
// apps/web/src/api-types.ts is GENERATED from apps/api/openapi.json by openapi-typescript
// (`pnpm --filter @derive/web gen:api-types`). This guards it: if the spec changed but the
// types weren't regenerated, the web client would silently drift from the backend contract.
// Regenerate to a temp file and compare; a mismatch fails `pnpm run ci`. The spec itself is
// snapshot-locked by apps/api/test/openapi.test.ts, so the whole chain — backend route →
// OpenAPI spec → web types — is machine-checked, never kept in sync by hand.
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

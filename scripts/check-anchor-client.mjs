// Asserts packages/core/src/anchor-client.generated.ts is in sync with its source
// (anchor-client.ts + anchor-shared.ts). esbuild is deterministic for a pinned version,
// so re-bundling and comparing catches a client edited without regenerating — the
// deterministic-gate pattern (like check-design-tokens et al). Run in CI + precommit.

import { readFileSync } from "node:fs"
import { generateAnchorClient, OUT } from "./build-anchor-client.mjs"

const fresh = await generateAnchorClient()
let committed = ""
try {
  committed = readFileSync(OUT, "utf8")
} catch {
  console.error("anchor-client: generated file is missing — run `pnpm build:anchor-client`")
  process.exit(1)
}

if (fresh !== committed) {
  console.error(
    "anchor-client: anchor-client.generated.ts is STALE.\n" +
      "  The in-iframe client source (anchor-client.ts / anchor-shared.ts) changed but the\n" +
      "  bundled output wasn't regenerated. Run `pnpm build:anchor-client` and commit.",
  )
  process.exit(1)
}
console.log("anchor-client: ok — generated bundle is in sync with source")

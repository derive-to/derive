import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

// The OAuth sign-in path inside REAL workerd, via Miniflare. Run with `pnpm test:worker`.
//
// This lane exists because this feature has already been broken once by the gap between Node and
// workerd, silently and in production: the broker held the global `fetch` on an object and called
// it as a method, which Node accepts and workerd rejects as an illegal invocation. Every Node test
// passed while nothing worked.
//
// WHAT IT CAN AND CANNOT CATCH, stated plainly, because a lane that oversells itself is worse than
// no lane. The pool SHIMS fetch, so it cannot catch that original binding defect — that is why an
// earlier attempt at a workerd lane for the broker was deleted rather than left to imply coverage
// it did not have. What it does catch is everything about running this code in workerd that is not
// fetch: whether `pkce-challenge` resolves to a variant workerd can load (its package exports have
// a `node` build that reaches for `node:crypto`), whether Web Crypto is where the code assumes,
// and whether the signed-state and credential paths work under the real runtime rather than Node's.
//
// nodejs_compat because apps/api's crypto helpers are node:crypto based, exactly as the deployed
// worker runs them (wrangler.toml sets the same flag).
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2025-05-01",
        compatibilityFlags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
      },
    }),
  ],
  test: { include: ["test/worker/**/*.test.ts"] },
})

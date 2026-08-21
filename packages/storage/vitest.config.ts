import { defineConfig } from "vitest/config"

// Coverage report (not a gate — see apps/api/vitest.config.ts) for the blob stores.
// All three drivers are exercised: fs (temp dir), R2 (a Map-backed R2Like), and S3
// (the SigV4 signer + put/get over a stubbed fetch).
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary"],
    },
  },
})

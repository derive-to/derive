import { defineConfig } from "vitest/config"

// Coverage gate on the blob stores. All three drivers are exercised: fs (temp dir),
// R2 (a Map-backed R2Like), and S3 (the SigV4 signer + put/get over a stubbed
// fetch). Thresholds sit just under the current numbers as a ratchet floor.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary"],
      // Ratchet floors. Only statements + lines gate — 18 fns / 38 branches swing
      // several % per unit, too jumpy for a hard gate. (current 98.9/100)
      thresholds: { statements: 92, lines: 95 },
    },
  },
})

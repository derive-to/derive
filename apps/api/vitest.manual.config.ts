import { defineConfig } from "vitest/config"

// Manual, network-dependent proofs. Kept OUT of the default suite so CI never depends on
// somebody else's server being reachable.
export default defineConfig({
  test: { include: ["test/**/*.manual.ts"], testTimeout: 60_000, hookTimeout: 60_000 },
})

import { defineConfig } from "vitest/config"

// Coverage gate on the shared domain logic: publish/storeContent (bundle entry +
// path cleaning), anchors, diff, unfurl, permissions, mime, hash, ids, md. ports.ts
// is type-only. Thresholds sit just under the current numbers as a ratchet floor.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // The injected browser client is DOM code end to end — ranges, caret hit
      // testing, contenteditable, postMessage across a sandboxed frame — and runs in
      // a real browser, never in this node suite; the Playwright specs
      // (inline-edit / deck smoke) are what cover it. Counted here it contributes
      // 2k+ permanently-uncovered lines, which turns this gate into a measure of how
      // BIG the client is rather than how well the shared logic is tested. Its
      // generated twin is one string constant.
      exclude: ["src/anchor-client.ts", "src/anchor-client.gen.ts"],
      reporter: ["text-summary"],
      // Ratchet floors just under current (92.5/83.0/92.5/94.3 with the browser
      // client out of the denominator). Raise over time.
      thresholds: { statements: 91, branches: 82, functions: 91, lines: 93 },
    },
  },
})

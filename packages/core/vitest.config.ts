import { defineConfig } from "vitest/config"

// Coverage report (not a gate — see apps/api/vitest.config.ts) for the shared domain
// logic: publish/storeContent, anchors, diff, unfurl, permissions, mime, hash, ids,
// md. ports.ts is type-only.
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
      // deck-template.html is source content imported as a raw string, not JavaScript.
      // Asking V8/Rolldown to remap it emits a parse error after an otherwise-green run.
      exclude: ["src/anchor-client.ts", "src/anchor-client.gen.ts", "src/**/*.html"],
      reporter: ["text-summary"],
    },
  },
})

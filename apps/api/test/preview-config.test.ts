import { execFileSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// The generator is a build script, so exercise it the way CI does — run it and read
// the config it prints. These assertions are the difference between a preview that
// demonstrates the branch and one that quietly demonstrates production.
const script = join(dirname(fileURLToPath(import.meta.url)), "../scripts/preview-config.mjs")
const generate = (name = "derive-pr-1234", url = "https://derive-pr-1234.example.workers.dev") =>
  execFileSync(process.execPath, [script, name, url], { encoding: "utf8" })

describe("preview-config", () => {
  const out = generate()

  it("renames the worker and repoints BASE_URL at the preview", () => {
    expect(out).toContain('name = "derive-pr-1234"')
    expect(out).not.toMatch(/^name = "derive"$/m)
    expect(out).toContain('BASE_URL = "https://derive-pr-1234.example.workers.dev"')
  })

  it("unsets DERIVE_SANDBOX_URL so /raw/* — and the injected iframe client — is served by THIS deployment", () => {
    // With the production value inherited, a preview 302s every /raw/* request to
    // raw.derive.page, so the frame runs PRODUCTION's derive-client.js and every
    // frame-side change under review (anchoring, cursors, decks, inline editing) is
    // invisible in the preview built to show it.
    expect(out).not.toMatch(/^DERIVE_SANDBOX_URL = /m)
    expect(out).toContain("DERIVE_SANDBOX_URL intentionally unset for previews")
  })

  it("still strips everything that would reach production", () => {
    expect(out).not.toContain("[[routes]]")
    expect(out).not.toContain("[triggers]")
    expect(out).not.toContain("queues.consumers")
  })

  it("keeps the shared data bindings (a preview with an empty database proves nothing)", () => {
    expect(out).toContain("[[d1_databases]]")
    expect(out).toContain("[[hyperdrive]]")
  })
})

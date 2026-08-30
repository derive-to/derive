import { execFileSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// The generator is a build script, so exercise it the way CI does — run it and read
// the config it prints. These assertions are the difference between a preview that
// demonstrates the branch and one that quietly demonstrates production.
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "../scripts/preview-config.mjs")
const script = scriptPath
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

  it("keeps Browser Rendering in export-only mode without enabling the shared preview sweep", () => {
    expect(out).toMatch(/^\[browser\]/m)
    expect(out).toContain('name = "PREVIEW_RENDERER"')
    expect(out).toContain('DERIVE_EXPORTS_ONLY = "true"')
    expect(out).toContain('DERIVE_QA_EMAIL_CAPTURE = "true"')
    expect(out).toContain('DERIVE_PREVIEW_MULTIPART = "true"')
    // The DO's migration stays: the class is still declared in the script, and
    // dropping an applied migration is what wrangler refuses.
    expect(out).toContain('new_sqlite_classes = ["PreviewRenderer"]')
  })

  it("removes the live mail transport; QA email is a reserved-.test capture", () => {
    expect(out).not.toMatch(/^\[\[send_email\]\]/m)
  })

  it("unsets the vanity-subdomain base, which a preview has no route for", () => {
    // A draft minted on a preview would otherwise write a live domain row into
    // production's table and then be served by production, not the branch.
    expect(out).not.toMatch(/^DERIVE_SUBDOMAIN_BASE = /m)
    expect(out).toContain("DERIVE_SUBDOMAIN_BASE intentionally unset for previews")
  })

  it("still strips everything that would reach production", () => {
    expect(out).not.toContain("[[routes]]")
    expect(out).not.toContain("[triggers]")
    expect(out).not.toContain("queues.consumers")
    expect(out).not.toContain("queues.producers")
  })
})

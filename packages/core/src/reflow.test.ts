import { describe, expect, it } from "vitest"
import { needsReflow, reflowHtml } from "./reflow"

describe("needsReflow", () => {
  it("flags a document with no viewport meta", () => {
    expect(
      needsReflow("<!doctype html><html><head><title>x</title></head><body>hi</body></html>"),
    ).toBe(true)
  })

  it("leaves a document that already declares a viewport (any quoting)", () => {
    expect(
      needsReflow('<html><head><meta name="viewport" content="width=device-width"></head></html>'),
    ).toBe(false)
    expect(
      needsReflow("<html><head><meta name=viewport content=width=device-width></head></html>"),
    ).toBe(false)
    expect(
      needsReflow(
        "<html><head><meta charset='utf-8'><meta name='viewport' content='...'></head></html>",
      ),
    ).toBe(false)
  })
})

describe("reflowHtml", () => {
  it("injects the viewport tag + reflow CSS + fit-to-width script right after <head>", () => {
    const out = reflowHtml(
      "<!doctype html><html><head><title>x</title></head><body>hi</body></html>",
    )
    expect(out).toContain('name="viewport"')
    expect(out).toContain("width=device-width")
    expect(out).toContain("data-dock-vp") // marker the fit-to-width script targets
    expect(out).toContain("data-dock-reflow")
    expect(out).toContain("scrollWidth") // the fit-to-width safeguard ships inline
    // Injected immediately after the opening <head>, before the author's <title>.
    expect(out.indexOf("data-dock-reflow")).toBeLessThan(out.indexOf("<title>"))
  })

  it("leaves an already-responsive document byte-for-byte unchanged", () => {
    const src =
      '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>x</title></head><body>hi</body></html>'
    expect(reflowHtml(src)).toBe(src)
  })

  it("is idempotent — a second pass is a no-op (the first added a viewport)", () => {
    const once = reflowHtml("<html><head></head><body>x</body></html>")
    expect(reflowHtml(once)).toBe(once)
  })

  it("reflows overflow rather than clipping it (no overflow:hidden on the page)", () => {
    const out = reflowHtml("<html><head></head><body><img src=x></body></html>")
    expect(out).toContain("max-width:100%")
    expect(out).toMatch(/table\{[^}]*overflow-x:auto/) // wide tables scroll in their box
    expect(out).not.toMatch(/html\{[^}]*overflow[^}]*hidden/) // never hide content
  })

  it("falls back to creating a <head> after <html> when none exists", () => {
    const out = reflowHtml("<html><body>only a body</body></html>")
    expect(out).toMatch(/<html><head>.*name="viewport"/s)
    expect(out).toContain("only a body")
  })

  it("prepends when there is neither <head> nor <html>", () => {
    const out = reflowHtml("<body>fragment</body>")
    expect(out.startsWith('<meta name="viewport"')).toBe(true)
    expect(out).toContain("fragment")
  })
})

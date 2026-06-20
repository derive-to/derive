import { describe, expect, it } from "vitest"
import { renderDocShell, sanitizeHtml } from "./md"
import { extractTitle, needsReflow, readerView, reflowHtml } from "./reflow"

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

describe("readerView", () => {
  const reader = (html: string) => readerView(html, renderDocShell, sanitizeHtml)

  it("strips author layout/scripts/styles and re-renders in the responsive shell", () => {
    const src =
      "<!doctype html><html><head><title>Spec</title><style>.p{width:1100px}</style></head>" +
      '<body><div class="p" style="width:1100px"><h2>Overview</h2><p>hello world</p>' +
      "<script>alert(1)</script></div></body></html>"
    const out = reader(src)
    expect(out).toContain("width=device-width") // responsive shell
    expect(out).toContain("<main>")
    expect(out).toContain("Overview")
    expect(out).toContain("hello world")
    expect(out).not.toContain("1100px") // author fixed width is gone (inline + <style>)
    expect(out).not.toContain("alert(1)") // script stripped
    expect(out).not.toContain('class="p"') // author classes dropped by sanitize
  })

  it("derives the title from <title>, falling back to the first <h1>", () => {
    expect(extractTitle("<html><head><title>  My Doc </title></head></html>")).toBe("My Doc")
    expect(extractTitle("<body><h1>Heading <b>X</b></h1></body>")).toBe("Heading X")
    expect(extractTitle("<body><p>no title here</p></body>")).toBe(null)
  })
})

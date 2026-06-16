import { describe, expect, it } from "vitest"
import {
  commonDir,
  cssAssetRefs,
  htmlAssetRefs,
  isLocalRef,
  planBundle,
  resolveRef,
} from "../src/lib/bundle-from-repo"

describe("resolveRef", () => {
  it("resolves relative, ../, ./ and root-absolute against the base dir", () => {
    expect(resolveRef("docs", "style.css")).toBe("docs/style.css")
    expect(resolveRef("docs", "./css/x.css")).toBe("docs/css/x.css")
    expect(resolveRef("docs/sub", "../style.css")).toBe("docs/style.css")
    expect(resolveRef("docs", "/assets/x.css")).toBe("assets/x.css") // root-absolute
    expect(resolveRef("docs", "img.png?v=2#frag")).toBe("docs/img.png") // strips query/hash
  })
  it("returns null when the reference escapes the repo root or is empty", () => {
    expect(resolveRef("docs", "../../etc/passwd")).toBeNull()
    expect(resolveRef("", "  ")).toBeNull()
  })
})

describe("isLocalRef", () => {
  it("accepts relative paths and rejects URLs / data / anchors", () => {
    expect(isLocalRef("style.css")).toBe(true)
    expect(isLocalRef("./a/b.css")).toBe(true)
    expect(isLocalRef("/root.css")).toBe(true)
    expect(isLocalRef("https://cdn/x.css")).toBe(false)
    expect(isLocalRef("//cdn/x.css")).toBe(false)
    expect(isLocalRef("data:image/png;base64,AAAA")).toBe(false)
    expect(isLocalRef("#anchor")).toBe(false)
    expect(isLocalRef("mailto:a@b.com")).toBe(false)
  })
})

describe("htmlAssetRefs", () => {
  it("pulls link/script/img/srcset/inline-css refs but NOT <a href>", () => {
    const html = `
      <link rel="stylesheet" href="css/site.css">
      <link rel="icon" href="/favicon.ico">
      <script src="app.js"></script>
      <img src="logo.png" srcset="logo.png 1x, logo@2x.png 2x">
      <a href="other.html">a page link, ignored</a>
      <div style="background:url('bg.jpg')"></div>
      <script src="https://cdn/ext.js"></script>`
    const refs = htmlAssetRefs(html)
    expect(refs).toContain("css/site.css")
    expect(refs).toContain("/favicon.ico")
    expect(refs).toContain("app.js")
    expect(refs).toContain("logo.png")
    expect(refs).toContain("logo@2x.png")
    expect(refs).toContain("bg.jpg")
    expect(refs).toContain("https://cdn/ext.js") // extracted; the caller filters non-local
    expect(refs).not.toContain("other.html") // <a> links are never pulled
  })

  it("handles unquoted attribute values (valid HTML5 / minified)", () => {
    const html = `<link rel=stylesheet href=style.css><script src=app.js></script><img src=logo.png>`
    const refs = htmlAssetRefs(html)
    expect(refs).toContain("style.css")
    expect(refs).toContain("app.js")
    expect(refs).toContain("logo.png")
  })
})

describe("cssAssetRefs", () => {
  it("extracts url() and @import targets", () => {
    const css = `@import "base.css";
      body { background: url(../img/hero.png); }
      @font-face { src: url('fonts/inter.woff2'); }`
    const refs = cssAssetRefs(css)
    expect(refs).toEqual(
      expect.arrayContaining(["base.css", "../img/hero.png", "fonts/inter.woff2"]),
    )
  })
})

describe("commonDir", () => {
  it("finds the deepest shared ancestor directory", () => {
    expect(commonDir(["docs/a.html", "docs/css/x.css"])).toBe("docs")
    expect(commonDir(["docs/a.html", "shared/x.css"])).toBe("")
    expect(commonDir(["site/a.html"])).toBe("site")
  })
})

describe("planBundle", () => {
  const tree = new Set([
    "docs/page.html",
    "docs/style.css",
    "shared/reset.css",
    "shared/fonts/inter.woff2",
    "docs/logo.png",
  ])
  const has = (p: string) => tree.has(p)
  const files: Record<string, string> = {
    "docs/style.css": `@import "../shared/reset.css"; body{background:url(logo.png)}`,
    "shared/reset.css": `@font-face{src:url(fonts/inter.woff2)}`,
  }
  const fetchText = async (p: string) => files[p] ?? null

  it("returns null when the HTML references no local assets", async () => {
    expect(await planBundle("docs/page.html", "<h1>hi</h1>", has, fetchText)).toBeNull()
    // External-only refs don't count.
    const ext = `<link href="https://cdn/x.css"><img src="data:image/png;base64,AA">`
    expect(await planBundle("docs/page.html", ext, has, fetchText)).toBeNull()
  })

  it("gathers HTML refs + one level of CSS, rooted at the common ancestor", async () => {
    const html = `<link rel="stylesheet" href="style.css"><img src="logo.png">`
    const plan = await planBundle("docs/page.html", html, has, fetchText)
    expect(plan).not.toBeNull()
    const paths = plan?.members.map((m) => m.repoPath).sort()
    // page + its css + img, plus the css's @import and the reset's @font-face (1 level).
    expect(paths).toEqual([
      "docs/logo.png",
      "docs/page.html",
      "docs/style.css",
      "shared/fonts/inter.woff2",
      "shared/reset.css",
    ])
    // Rooted at repo root (page is under docs/, reset under shared/).
    expect(plan?.root).toBe("")
    expect(plan?.entryRel).toBe("docs/page.html")
    const rel = Object.fromEntries(plan?.members.map((m) => [m.repoPath, m.rel]) ?? [])
    expect(rel["docs/style.css"]).toBe("docs/style.css")
  })

  it("ignores references to files that aren't in the repo tree", async () => {
    const html = `<link href="style.css"><script src="missing.js">`
    const plan = await planBundle("docs/page.html", html, has, fetchText)
    expect(plan?.members.some((m) => m.repoPath === "docs/missing.js")).toBe(false)
  })
})

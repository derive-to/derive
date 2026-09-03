import {
  type BlobStore,
  BUNDLE_CONTENT_TYPE,
  type BundleManifest,
  KATEX_ASSET_BASE,
  LATEX_BUNDLE_CONTENT_TYPE,
  LATEX_CONTENT_TYPE,
  SKILL_CONTENT_TYPE,
} from "@derive/core"
import type { Context } from "hono"
import { describe, expect, it, vi } from "vitest"
import { RAW_HEADERS } from "../src/lib/http"
import { serveContent } from "../src/lib/serve-content"

const enc = (s: string) => new TextEncoder().encode(s)

// Fake BlobStore — serveContent only ever calls get().
const blobStore = (entries: Record<string, Uint8Array | string>): BlobStore => {
  const map = new Map<string, Uint8Array>()
  for (const [k, v] of Object.entries(entries)) map.set(k, typeof v === "string" ? enc(v) : v)
  return { get: async (key: string) => map.get(key) ?? null } as unknown as BlobStore
}

// Minimal Hono context: serveContent calls c.body / c.text (each yielding a Response)
// and c.req.query (the `?raw=1` markdown-source escape). `query` defaults to empty.
const ctx = (query: Record<string, string> = {}): Context =>
  ({
    req: { query: (k: string) => query[k] },
    body: (data: BodyInit | null, status = 200, headers?: Record<string, string>) =>
      new Response(data, { status, headers }),
    text: (msg: string, status = 200, headers?: Record<string, string>) =>
      new Response(msg, { status, headers: headers ?? {} }),
  }) as unknown as Context

const CSP = RAW_HEADERS["Content-Security-Policy"]
const IMMUTABLE = "public, max-age=31536000, immutable"

// The opaque-origin sandbox headers must ride EVERY response serveContent produces.
const expectSandbox = (res: Response, cache: string = IMMUTABLE) => {
  expect(res.headers.get("content-security-policy")).toBe(CSP)
  expect(res.headers.get("x-content-type-options")).toBe("nosniff")
  expect(res.headers.get("x-robots-tag")).toBe("noindex")
  expect(res.headers.get("cache-control")).toBe(cache)
}

const SCRIPT = "/raw/derive-client.js"
const SHARED = "/raw/derive-shared.js"

describe("serveContent — single-file artifacts", () => {
  it("serves an HTML file with the anchor client and the sandbox headers", async () => {
    const res = await serveContent(
      ctx(),
      blobStore({ k: "<h1>Hi</h1>" }),
      { blob_key: "k", content_type: "text/html" },
      "Title",
      "/",
      "",
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    const body = await res.text()
    expect(body).toContain("<h1>Hi</h1>")
    expect(body).toContain(SCRIPT)
    // Both platform runtimes are available even when an authored meta CSP follows.
    // The DOM-dependent client is deferred until parsing completes.
    expect(body).toContain(SHARED)
    expect(body.indexOf(SHARED)).toBeLessThan(body.indexOf("<h1>Hi</h1>"))
    expect(body.indexOf(SCRIPT)).toBeLessThan(body.indexOf("<h1>Hi</h1>"))
    expect(body).toContain('<script defer src="/raw/derive-client.js"></script>')
    expectSandbox(res)
  })

  it("disables structural handles when source attributes are ambiguous", async () => {
    const malformed = `<section data-derive-region="r" data-derive-layout="stack">
  <p data-derive-node="a" data-derive-node="b">A</p>
  <p data-derive-node="c">C</p>
</section>`
    const res = await serveContent(
      ctx(),
      blobStore({ k: malformed }),
      { blob_key: "k", content_type: "text/html" },
      "Malformed structure",
      "/",
      "",
    )
    const body = await res.text()
    expect(body).toContain('Object.defineProperty(window,"__deriveStructuralSourceValid"')
    expect(body).toContain(malformed)
    expect(body.indexOf("__deriveStructuralSourceValid")).toBeLessThan(body.indexOf(SCRIPT))
  })

  it("does not disable handles for a valid structural contract", async () => {
    const valid = `<section data-derive-region="r" data-derive-layout="stack">
  <p data-derive-node="a">A</p>
  <p data-derive-node="b">B</p>
</section>`
    const res = await serveContent(
      ctx(),
      blobStore({ k: valid }),
      { blob_key: "k", content_type: "text/html" },
      "Valid structure",
      "/",
      "",
    )
    expect(await res.text()).not.toContain('__deriveStructuralSourceValid",{value:false}')
  })

  it("keeps handles enabled for a valid horizontal row contract", async () => {
    const valid = `<section data-derive-region="cards" data-derive-layout="row">
  <article data-derive-node="a">A</article>
  <article data-derive-node="b">B</article>
</section>`
    const res = await serveContent(
      ctx(),
      blobStore({ k: valid }),
      { blob_key: "k", content_type: "text/x-derive-deck" },
      "Row deck",
      "/",
      "",
    )
    const body = await res.text()
    expect(body).not.toContain('__deriveStructuralSourceValid",{value:false}')
    expect(body).toContain('data-derive-layout="row"')
  })

  it("optimistically exposes safe legacy deck children as structural nodes", async () => {
    const deck = `<main>
  <section class="slide" data-derive-slide="0"><h2>A</h2><p>Alpha</p></section>
  <section class="slide" data-derive-slide="1"><h2>B</h2><figure>Beta</figure></section>
</main><script>parent.postMessage({source:'derive-deck',type:'deck',n:2},'*')</script>`
    const res = await serveContent(
      ctx(),
      blobStore({ k: deck }),
      { blob_key: "k", content_type: "text/x-derive-deck" },
      "Legacy deck",
      "/",
      "",
    )
    const body = await res.text()
    expect(body).toContain('data-derive-runtime-region="slide-0"')
    expect(body).toContain('data-derive-runtime-node="slide-0-node-1"')
    expect(body).not.toContain('data-derive-region="slide-0"')
    expect(body).not.toContain('data-derive-node="slide-0-node-1"')
    expect(body).toContain("data-derive-structural-backfill")
    // The stored blob is immutable; this is a deterministic effective-source view.
    expect(deck).not.toContain("data-derive-region")
  })

  it("loads Derive's runtimes before an authored meta CSP", async () => {
    const authoredCsp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src https://unpkg.com">`
    const res = await serveContent(
      ctx(),
      blobStore({
        k: `<!doctype html><html><head>${authoredCsp}</head><body><h1>Visible</h1></body></html>`,
      }),
      { blob_key: "k", content_type: "text/html" },
      "CSP document",
      "/",
      "",
    )
    const body = await res.text()
    expect(body.indexOf("charset=utf-8")).toBeLessThan(body.indexOf(SHARED))
    expect(body.indexOf(SHARED)).toBeLessThan(body.indexOf(authoredCsp))
    expect(body.indexOf(SCRIPT)).toBeLessThan(body.indexOf(authoredCsp))
  })

  it("renders markdown to HTML", async () => {
    const res = await serveContent(
      ctx(),
      blobStore({ k: "# Hello" }),
      { blob_key: "k", content_type: "text/markdown" },
      "Doc",
      "/",
      "",
    )
    expect(res.headers.get("content-type")).toContain("text/html")
    const body = await res.text()
    expect(body).toContain("<h1")
    expect(body).toContain(SCRIPT)
    expect(body.match(/\/raw\/derive-client\.js/g)).toHaveLength(1)
    expect(body).toContain(SHARED)
  })

  it("self-heals a blob mislabeled markdown that is actually a full HTML document", async () => {
    const onMismatch = vi.fn()
    const html =
      "<!DOCTYPE html><html><head><style>b{}</style></head><body>real content</body></html>"
    const res = await serveContent(
      ctx(),
      blobStore({ k: html }),
      { blob_key: "k", content_type: "text/markdown" },
      null,
      "/",
      "",
      IMMUTABLE,
      onMismatch,
    )
    expect(onMismatch).toHaveBeenCalledOnce()
    expect(res.headers.get("content-type")).toContain("text/html")
    const body = await res.text()
    // Served verbatim (the <style> survives — the markdown path would have stripped it),
    // never the blank page.
    expect(body).toContain("<style>b{}</style>")
    expect(body).toContain("real content")
    expect(body).toContain(SCRIPT)
  })

  it("uses the gated Cache-Control for a non-public artifact (never immutable)", async () => {
    const res = await serveContent(
      ctx(),
      blobStore({ k: "<h1>x</h1>" }),
      { blob_key: "k", content_type: "text/html" },
      null,
      "/",
      "",
      "private, no-store",
    )
    expectSandbox(res, "private, no-store")
  })
})

describe("serveContent — dynamic tables and figures", () => {
  const DYNAMIC = "/raw/derive-dynamic.js"
  const fence = [
    "# Results",
    "",
    "```derive-table results",
    "| Model | Acc |",
    "| --- | --- |",
    "| base | -- |",
    "```",
    "",
  ].join("\n")
  const slot = (json: string) => ({
    id: "dyn_1",
    artifact_id: "a",
    n: 1,
    name: "results",
    kind: "table" as const,
    json,
    size_bytes: json.length,
    revision: 3,
    updated_by_id: "amy",
    updated_by_name: "Amy",
    updated_at: "2026-01-01T00:00:00.000Z",
  })
  const results = JSON.stringify({
    kind: "table",
    table: { columns: [{ key: "model" }, { key: "acc" }], rows: [{ model: "ours", acc: 0.9 }] },
  })
  const serve = (content: { blob_key: string; content_type: string }, dynamic = [slot(results)]) =>
    serveContent(
      ctx(),
      blobStore({
        md: fence,
        html: '<table data-derive-table="results"><caption>Totals</caption><tr><td>old</td></tr></table><table><tr><td>plain</td></tr></table>',
      }),
      content,
      "T",
      "/",
      "",
      IMMUTABLE,
      undefined,
      true,
      true,
      "",
      dynamic,
    )

  it("substitutes a markdown fence with the slot's current value and injects the runtime", async () => {
    const res = await serve({ blob_key: "md", content_type: "text/markdown" })
    const body = await res.text()
    expect(body).toContain('<table data-derive-table="results">')
    expect(body).toContain("<td>ours</td><td>0.9</td>")
    expect(body).not.toContain("base")
    expect(body).toContain(DYNAMIC)
    expect(body).toContain(SHARED)
    expect(body.split(SCRIPT).length).toBe(2) // the anchor client exactly once
    expectSandbox(res)
  })

  it("renders the placeholder and skips the runtime when no slot is bound", async () => {
    const res = await serve({ blob_key: "md", content_type: "text/markdown" }, [])
    const body = await res.text()
    expect(body).toContain("<td>base</td><td>--</td>")
    expect(body).not.toContain(DYNAMIC)
  })

  it("replaces a bound HTML table's rows, keeps its caption, leaves unbound tables alone", async () => {
    const res = await serve({ blob_key: "html", content_type: "text/html" })
    const body = await res.text()
    expect(body).toContain('<table data-derive-table="results"><caption>Totals</caption><thead>')
    expect(body).toContain("<td>ours</td><td>0.9</td>")
    expect(body).not.toContain("old")
    expect(body).toContain("<table><tr><td>plain</td></tr></table>")
    expect(body).toContain(DYNAMIC)
    expectSandbox(res)
  })

  it("renders the placeholder when a stored value no longer validates", async () => {
    const res = await serve({ blob_key: "md", content_type: "text/markdown" }, [slot("{not json")])
    const body = await res.text()
    expect(body).toContain("<td>base</td><td>--</td>")
    expect(body).not.toContain(DYNAMIC)
  })
})

describe("serveContent — bundles", () => {
  const manifest: BundleManifest = {
    entry: "/index.html",
    spa: false,
    files: {
      "/index.html": { key: "k_idx", type: "text/html; charset=utf-8" },
      "/style.css": { key: "k_css", type: "text/css; charset=utf-8" },
      "/img.png": { key: "k_img", type: "image/png" },
    },
  }
  const prefix = "/raw/abc/v/1/"
  const bundleBlobs = (over: Partial<Record<string, Uint8Array | string>> = {}) =>
    blobStore({
      kManifest: JSON.stringify(manifest),
      k_idx: '<a href="/deep">home</a>',
      k_css: "a{color:red}",
      k_img: Uint8Array.from([1, 2, 3, 4]),
      ...over,
    })
  const content = { blob_key: "kManifest", content_type: BUNDLE_CONTENT_TYPE }

  it("serves the entry page: scope-rewritten links + the anchor client", async () => {
    const res = await serveContent(ctx(), bundleBlobs(), content, "Site", prefix, "")
    expect(res.headers.get("content-type")).toContain("text/html")
    const body = await res.text()
    expect(body).toContain('href="/raw/abc/v/1/deep"') // root-absolute link kept in scope
    expect(body).toContain(SCRIPT)
    expectSandbox(res)
  })

  it("serves a CSS page rewritten but WITHOUT the anchor client", async () => {
    const res = await serveContent(ctx(), bundleBlobs(), content, "Site", prefix, "style.css")
    expect(res.headers.get("content-type")).toContain("text/css")
    const body = await res.text()
    expect(body).toBe("a{color:red}")
    expect(body).not.toContain(SCRIPT)
    expect(body).not.toContain(SHARED)
  })

  it("404s an unknown bundle path, still with the sandbox headers", async () => {
    const res = await serveContent(ctx(), bundleBlobs(), content, "Site", prefix, "nope.html")
    expect(res.status).toBe(404)
    expect(res.headers.get("content-security-policy")).toBe(CSP)
  })

  it("falls back to the entry page for an SPA route with no matching file", async () => {
    const spaManifest: BundleManifest = { ...manifest, spa: true }
    const res = await serveContent(
      ctx(),
      bundleBlobs({ kManifest: JSON.stringify(spaManifest) }),
      content,
      "Site",
      prefix,
      "app/some/route",
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(await res.text()).toContain("home") // the entry document
  })
})

describe("serveContent — skill / markdown bundles", () => {
  // A skill folder: entry is SKILL.md, plus a script (served raw) and a reference doc.
  const manifest: BundleManifest = {
    entry: "/SKILL.md",
    spa: false,
    files: {
      "/SKILL.md": { key: "k_skill", type: "text/markdown; charset=utf-8" },
      "/scripts/run.sh": { key: "k_sh", type: "application/octet-stream" },
    },
  }
  const prefix = "/raw/sk/v/1/"
  const skillMd = "---\nname: my-skill\ndescription: does things\n---\n\n# My Skill\n\nbody text"
  const blobs = blobStore({
    kManifest: JSON.stringify(manifest),
    k_skill: skillMd,
    k_sh: "#!/usr/bin/env bash\necho hi\n",
  })
  // A real skill carries the derive/skill content type; serveContent must still treat
  // it as a bundle (isBundleContentType), not fall through to single-file handling.
  const content = { blob_key: "kManifest", content_type: SKILL_CONTENT_TYPE }

  it("renders the SKILL.md entry as HTML, frontmatter stripped, with the anchor client", async () => {
    const res = await serveContent(ctx(), blobs, content, "my-skill", prefix, "")
    expect(res.headers.get("content-type")).toContain("text/html")
    const body = await res.text()
    expect(body).toContain("<h1") // the body heading rendered
    expect(body).toContain("My Skill")
    expect(body).not.toContain("name: my-skill") // frontmatter stripped, not shown
    expect(body).toContain(SCRIPT)
    expectSandbox(res)
  })

  it("serves the markdown source verbatim with ?raw=1", async () => {
    const res = await serveContent(
      ctx({ raw: "1" }),
      blobs,
      content,
      "my-skill",
      prefix,
      "SKILL.md",
    )
    expect(res.headers.get("content-type")).toContain("text/markdown")
    expect(await res.text()).toBe(skillMd)
  })
})

describe("serveContent — LaTeX", () => {
  const paper =
    "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\nA formula $E=mc^2$ and a \\cite{k}.\n\\bibliography{refs}\n\\end{document}\n"
  const content = { blob_key: "k", content_type: LATEX_CONTENT_TYPE }

  it("renders a single .tex file as a paper with the typesetter in the head", async () => {
    const onMismatch = vi.fn()
    const res = await serveContent(
      ctx(),
      blobStore({ k: paper }),
      content,
      "Paper",
      "/",
      "",
      IMMUTABLE,
      onMismatch,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    const body = await res.text()
    expect(body).toContain("<main data-derive-ready>")
    expect(body).toContain('<h2 id="intro"><span class="derive-secnum">1</span> Intro</h2>')
    expect(body).toContain('data-tex="E=mc^2"')
    expect(body).toContain(`${KATEX_ASSET_BASE}/katex.min.js`)
    expect(body.split(SCRIPT).length).toBe(2) // the anchor client exactly once
    expect(body).toContain(SHARED)
    // Alone, the paper cannot reach refs.bib: the citation shows its key, never a blank.
    expect(body).toContain("[k?]")
    expect(onMismatch).not.toHaveBeenCalled()
    expectSandbox(res)
  })

  it("serves the source at raw.tex", async () => {
    const res = await serveContent(ctx(), blobStore({ k: paper }), content, "Paper", "/", "raw.tex")
    expect(res.headers.get("content-type")).toBe("text/x-latex; charset=utf-8")
    expect(await res.text()).toBe(paper)
    expectSandbox(res)
  })

  it("leaves the typesetter out of a paper with no math", async () => {
    const res = await serveContent(
      ctx(),
      blobStore({ k: "\\begin{document}Prose only.\\end{document}" }),
      content,
      "Paper",
      "/",
      "",
    )
    expect(await res.text()).not.toContain("katex")
  })

  it("renders a bound \\derivetable with the slot's current value and the runtime", async () => {
    const bound = "\\begin{document}\\derivetable{results}\\end{document}"
    const slot = {
      name: "results",
      kind: "table",
      json: JSON.stringify({
        kind: "table",
        table: { columns: [{ key: "m" }], rows: [{ m: "live" }] },
      }),
    }
    const res = await serveContent(
      ctx(),
      blobStore({ k: bound }),
      content,
      "Paper",
      "/",
      "",
      IMMUTABLE,
      undefined,
      true,
      true,
      "",
      [slot as never],
    )
    const body = await res.text()
    expect(body).toContain('<table data-derive-table="results"')
    expect(body).toContain("<td>live</td>")
    expect(body).toContain("/raw/derive-dynamic.js")
  })
})

describe("serveContent — paper bundles", () => {
  const manifest: BundleManifest = {
    entry: "/main.tex",
    spa: false,
    files: {
      "/main.tex": { key: "k_main", type: "text/x-latex; charset=utf-8" },
      "/sec/intro.tex": { key: "k_intro", type: "text/x-latex; charset=utf-8" },
      "/refs.bib": { key: "k_bib", type: "text/plain; charset=utf-8" },
      "/fig/plot.png": { key: "k_png", type: "image/png" },
      "/README.md": { key: "k_readme", type: "text/markdown; charset=utf-8" },
    },
  }
  const prefix = "/raw/pp/v/3/"
  const main =
    "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\n\\input{sec/intro}\n\\begin{figure}\\includegraphics[width=\\linewidth]{fig/plot}\\caption{Plot}\\end{figure}\n\\bibliography{refs}\n\\end{document}\n"
  const blobs = blobStore({
    kManifest: JSON.stringify(manifest),
    k_main: main,
    k_intro: "Included text cites \\cite{doe2024}.",
    k_bib: "@misc{doe2024, author={Jane Doe}, title={A Note}, year={2024}}",
    k_png: Uint8Array.from([137, 80, 78, 71]),
    k_readme: "# Paper\n",
  })
  const content = { blob_key: "kManifest", content_type: LATEX_BUNDLE_CONTENT_TYPE }

  it("renders main.tex with its inputs, bibliography and figures resolved", async () => {
    const res = await serveContent(ctx(), blobs, content, "Paper", prefix, "")
    expect(res.headers.get("content-type")).toContain("text/html")
    const body = await res.text()
    expect(body).toContain("Included text cites")
    expect(body).toContain('[<a class="derive-cite" href="#ref-doe2024">1</a>]')
    expect(body).toContain("Jane Doe. A Note. 2024.")
    expect(body).toContain(`<img src="${prefix}fig/plot.png"`)
    expect(body).toContain(SCRIPT)
    expectSandbox(res)
  })

  it("serves a .tex source with ?raw=1 and the .bib as text", async () => {
    const raw = await serveContent(ctx({ raw: "1" }), blobs, content, "Paper", prefix, "main.tex")
    expect(raw.headers.get("content-type")).toBe("text/x-latex; charset=utf-8")
    expect(await raw.text()).toBe(main)
    const bib = await serveContent(ctx(), blobs, content, "Paper", prefix, "refs.bib")
    expect(bib.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(await bib.text()).toContain("@misc{doe2024")
    expectSandbox(bib)
  })

  it("still renders a markdown sibling through the markdown path", async () => {
    const res = await serveContent(ctx(), blobs, content, "Paper", prefix, "README.md")
    expect(await res.text()).toContain("<h1")
  })
})

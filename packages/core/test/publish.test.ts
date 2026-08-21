import { zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { sha256Hex } from "../src/hash"
import type { ArtifactRecord, BlobStore, MetaStore, NewArtifact, NewVersion } from "../src/ports"
import { artifactUrl, looksLikeHtmlDocument, type PublishInput, publish } from "../src/publish"

// publish() stores content then writes the artifact/version. The
// interesting, security-relevant logic is storeContent's bundle handling (zip
// entry detection + path cleaning), reachable only through publish(). Drive it with
// a Map-backed blob store and a tiny fake MetaStore implementing just the handful of
// methods these two functions touch.
const makeBlobs = (): BlobStore => {
  const map = new Map<string, Uint8Array>()
  return {
    put: async (d) => {
      const k = await sha256Hex(d)
      map.set(k, d)
      return k
    },
    get: async (k) => map.get(k) ?? null,
  }
}

// A focused in-memory fake: only the handful of methods publish() actually calls,
// over plain records (no `any`). Cast through MetaStore at the end —
// the uncalled ~75 methods are never reached.
type FakeArtifact = NewArtifact & { current_version: number; created_at: string; removed_at: null }
type FakeVersion = NewVersion & { n: number; artifact_id: string; created_at: string }

const makeMeta = (): MetaStore => {
  const byShort = new Map<string, FakeArtifact>()
  const byId = new Map<string, FakeArtifact>()
  const versions = new Map<string, FakeVersion[]>()
  const meta = {
    createArtifact: async (a: NewArtifact): Promise<FakeArtifact> => {
      // Mirror the store's fail-closed column defaults for omitted access fields
      // (drizzle omits `undefined` keys on insert, so the DB default applies).
      const rec: FakeArtifact = {
        ...a,
        workspace_access: a.workspace_access ?? "none",
        link_role: a.link_role ?? "none",
        listed: a.listed ?? "none",
        current_version: 0,
        created_at: "t",
        removed_at: null,
      }
      byShort.set(a.short_id, rec)
      byId.set(a.id, rec)
      return rec
    },
    getByShortId: async (s: string) => byShort.get(s) ?? null,
    getArtifactById: async (id: string) => byId.get(id) ?? null,
    addVersion: async (artifactId: string, v: NewVersion): Promise<FakeVersion> => {
      const list = versions.get(artifactId) ?? []
      const rec: FakeVersion = {
        ...v,
        n: list.length + 1,
        artifact_id: artifactId,
        created_at: "t",
      }
      list.push(rec)
      versions.set(artifactId, list)
      const art = byId.get(artifactId)
      if (art) art.current_version = rec.n
      return rec
    },
    setVersionPreview: async () => {},
  }
  return meta as unknown as MetaStore
}

const file = (body: string, over: Partial<PublishInput> = {}): PublishInput => ({
  bytes: new TextEncoder().encode(body),
  filename: "page.html",
  isBundle: false,
  ...over,
})

const zip = (files: Record<string, string>): Uint8Array =>
  zipSync(
    Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)])),
  )

const bundle = (files: Record<string, string>, over: Partial<PublishInput> = {}): PublishInput => ({
  bytes: zip(files),
  filename: "site.zip",
  isBundle: true,
  ...over,
})

describe("publish: single file", () => {
  it("creates an artifact + first version, titled from the filename", async () => {
    const meta = makeMeta()
    const blobs = makeBlobs()
    const { artifact, version } = await publish(meta, blobs, file("<h1>hi</h1>"))
    expect(artifact.kind).toBe("file")
    expect(artifact.title).toBe("page") // ".html" stripped
    // Publishing without access fields is fail-closed — nobody but the publisher
    // (the route writes them as the owner-member) until widened. The route, not
    // publish(), applies the product default (workspace_access member).
    expect(artifact.workspace_access).toBe("none")
    expect(artifact.link_role).toBe("none")
    expect(artifact.listed).toBe("none")
    expect(version.n).toBe(1)
    expect(version.content_type).toBe("text/html")
    expect(new TextDecoder().decode((await blobs.get(version.blob_key)) ?? undefined)).toBe(
      "<h1>hi</h1>",
    )
  })

  it("recognizes a valid linked-bundle fact without changing the file kind", async () => {
    const body = `<!doctype html><html><body><a href="/artifacts/abc12345">Brief</a><script type="application/derive-facts" data-fact="bundle-manifest">{"schema":"derive.linked-bundle/v1","purpose":"Keep the work together","members":[{"id":"brief","ref":"abc12345","label":"Brief"}]}</script></body></html>`
    const { artifact, version } = await publish(makeMeta(), makeBlobs(), file(body))
    expect(artifact.kind).toBe("file")
    expect(version.content_type).toBe("text/x-derive-linked-bundle")
  })

  it("honors explicit title, access, and author", async () => {
    const { artifact, version } = await publish(
      makeMeta(),
      makeBlobs(),
      file("x", {
        title: "Custom",
        workspaceAccess: "member",
        linkRole: "viewer",
        listed: "public",
        author: "amy",
      }),
    )
    expect(artifact.title).toBe("Custom")
    expect(artifact.workspace_access).toBe("member")
    expect(artifact.link_role).toBe("viewer")
    expect(artifact.listed).toBe("public")
    expect(version.author).toBe("amy")
  })
})

describe("publish: bundles (zip)", () => {
  it("prefers a root index.html as the entry point", async () => {
    const blobs = makeBlobs()
    const { artifact, version } = await publish(
      makeMeta(),
      blobs,
      bundle({ "index.html": "<h1>home</h1>", "style.css": "body{}" }),
    )
    expect(artifact.kind).toBe("bundle")
    const manifest = JSON.parse(
      new TextDecoder().decode((await blobs.get(version.blob_key)) ?? undefined),
    )
    expect(manifest.entry).toBe("/index.html")
    expect(Object.keys(manifest.files).sort()).toEqual(["/index.html", "/style.css"])
  })

  it("falls back to the shallowest html when there's no root index", async () => {
    const blobs = makeBlobs()
    const { version } = await publish(
      makeMeta(),
      blobs,
      bundle({ "deep/a/b.html": "x", "top.html": "y" }),
    )
    const manifest = JSON.parse(
      new TextDecoder().decode((await blobs.get(version.blob_key)) ?? undefined),
    )
    expect(manifest.entry).toBe("/top.html")
  })

  it("strips path-traversal, __MACOSX, and .DS_Store entries", async () => {
    const blobs = makeBlobs()
    const { version } = await publish(
      makeMeta(),
      blobs,
      bundle({
        "../escape.html": "no",
        "__MACOSX/x": "no",
        ".DS_Store": "no",
        "ok.html": "yes",
      }),
    )
    const manifest = JSON.parse(
      new TextDecoder().decode((await blobs.get(version.blob_key)) ?? undefined),
    )
    expect(Object.keys(manifest.files)).toEqual(["/ok.html"])
    expect(manifest.entry).toBe("/ok.html")
  })

  it("rejects a non-zip, an empty bundle, and one with neither html nor markdown", async () => {
    const meta = makeMeta()
    const blobs = makeBlobs()
    await expect(
      publish(meta, blobs, {
        bytes: new TextEncoder().encode("not a zip"),
        filename: "x.zip",
        isBundle: true,
      }),
    ).rejects.toMatchObject({ statusCode: 400 })
    await expect(publish(meta, blobs, bundle({}))).rejects.toMatchObject({ statusCode: 400 })
    // A bundle of only non-renderable files (no .html, no .md) still has no entry.
    await expect(publish(meta, blobs, bundle({ "readme.txt": "hi" }))).rejects.toMatchObject({
      statusCode: 400,
    })
  })

  it("publishes a skill folder (SKILL.md + scripts, no HTML), entry = /SKILL.md", async () => {
    const blobs = makeBlobs()
    const { artifact, version } = await publish(
      makeMeta(),
      blobs,
      bundle({
        "SKILL.md": "---\nname: my-skill\ndescription: does things\n---\n\n# My Skill\n\nbody",
        "scripts/run.sh": "#!/usr/bin/env bash\necho hi\n",
        "references/notes.md": "# Notes",
      }),
    )
    expect(artifact.kind).toBe("bundle")
    const manifest = JSON.parse(
      new TextDecoder().decode((await blobs.get(version.blob_key)) ?? undefined),
    )
    expect(manifest.entry).toBe("/SKILL.md")
    expect(Object.keys(manifest.files).sort()).toEqual([
      "/SKILL.md",
      "/references/notes.md",
      "/scripts/run.sh",
    ])
  })

  it("a root SKILL.md wins the entry over a nested HTML reference (still a skill)", async () => {
    const blobs = makeBlobs()
    const { version } = await publish(
      makeMeta(),
      blobs,
      bundle({
        "SKILL.md": "---\nname: chart-style\ndescription: how we chart\n---\n\n# Chart style",
        "references/example.html": "<!doctype html><h1>example</h1>",
      }),
    )
    const manifest = JSON.parse(
      new TextDecoder().decode((await blobs.get(version.blob_key)) ?? undefined),
    )
    // Not references/example.html — the skill keeps its identity despite shipping HTML.
    expect(manifest.entry).toBe("/SKILL.md")
    // A skill carries the distinct content type so the library can badge it for free.
    expect(version.content_type).toBe("derive/skill")
  })

  it("prefers HTML over SKILL.md, and falls back to README.md / shallowest .md", async () => {
    const blobs = makeBlobs()
    // HTML wins even when a SKILL.md is present.
    const a = await publish(makeMeta(), blobs, bundle({ "SKILL.md": "# s", "index.html": "<h1>" }))
    const ma = JSON.parse(
      new TextDecoder().decode((await blobs.get(a.version.blob_key)) ?? undefined),
    )
    expect(ma.entry).toBe("/index.html")
    // No HTML, no SKILL.md → README.md.
    const b = await publish(makeMeta(), blobs, bundle({ "README.md": "# r", "deep/x.md": "# x" }))
    const mb = JSON.parse(
      new TextDecoder().decode((await blobs.get(b.version.blob_key)) ?? undefined),
    )
    expect(mb.entry).toBe("/README.md")
    // No HTML, no SKILL/README → shallowest markdown.
    const c = await publish(makeMeta(), blobs, bundle({ "deep/a/b.md": "# b", "top.md": "# t" }))
    const mc = JSON.parse(
      new TextDecoder().decode((await blobs.get(c.version.blob_key)) ?? undefined),
    )
    expect(mc.entry).toBe("/top.md")
  })

  it("a context source dir enters at MANIFEST.md even when a README sits beside it", async () => {
    // The entry is the runner's system prompt — a docs README must not hijack it.
    const blobs = makeBlobs()
    const a = await publish(
      makeMeta(),
      blobs,
      bundle({ "MANIFEST.md": "# m", "README.md": "# r", "references/schema.md": "# s" }),
    )
    const ma = JSON.parse(
      new TextDecoder().decode((await blobs.get(a.version.blob_key)) ?? undefined),
    )
    expect(ma.entry).toBe("/MANIFEST.md")
  })
})

describe("publish: republish an existing artifact", () => {
  it("records validated derivation lineage on creation", async () => {
    const meta = makeMeta()
    const blobs = makeBlobs()
    const source = await publish(meta, blobs, file("source"))
    const copy = await publish(meta, blobs, { ...file("copy"), derivedFrom: source.artifact.id })
    expect(copy.artifact.derived_from).toBe(source.artifact.id)
  })

  it("appends a version under the same short id", async () => {
    const meta = makeMeta()
    const blobs = makeBlobs()
    const { artifact } = await publish(meta, blobs, file("v1"))
    const { version } = await publish(meta, blobs, file("v2"), artifact.short_id)
    expect(version.n).toBe(2)
  })

  it("404s for an unknown short id and 409s on a kind change", async () => {
    const meta = makeMeta()
    const blobs = makeBlobs()
    await expect(publish(meta, blobs, file("x"), "missing")).rejects.toMatchObject({
      statusCode: 404,
    })
    const { artifact } = await publish(meta, blobs, file("a file"))
    await expect(
      publish(meta, blobs, bundle({ "index.html": "x" }), artifact.short_id),
    ).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe("publish: URL + JSON helpers", () => {
  const artifact = {
    short_id: "abc123",
    slug: "my-doc",
    title: "My Doc",
    kind: "file",
    workspace_access: "member",
    link_role: "none",
    listed: "none",
    spa: 0,
    current_version: 2,
    created_at: "t",
  } as unknown as ArtifactRecord

  it("artifactUrl is name-first: explicit slug, else slug-from-title, else bare", () => {
    // Name-first refs (#130): <name>-<short_id>.
    expect(artifactUrl("https://derive.test", artifact)).toBe(
      "https://derive.test/artifacts/my-doc-abc123",
    )
    // No explicit slug → derive the name from the current title (so links stay readable
    // and rename-safe without a backfill).
    expect(artifactUrl("https://derive.test", { ...artifact, slug: null })).toBe(
      "https://derive.test/artifacts/my-doc-abc123",
    )
    // No slug and no title → the bare short id.
    expect(artifactUrl("https://derive.test", { ...artifact, slug: null, title: null })).toBe(
      "https://derive.test/artifacts/abc123",
    )
  })
})

// looksLikeHtmlDocument is the trigger for serve-content's "never serve a blank
// page" self-heal: a blob mislabeled text/markdown whose bytes are really a full
// HTML document is served verbatim as HTML instead of run through the markdown
// renderer (which would strip <head>/<style>/scripts and show white). So the
// boundary that matters is full-document vs. not — false positives would serve a
// fragment as a document; false negatives bring the blank screen back.

describe("looksLikeHtmlDocument", () => {
  it("detects a headless designed page by its head/meta/style openers", () => {
    // The 2026-07 dogfood miss: a styled report opening with <meta>/<style> (no
    // doctype) rendered its CSS as visible text through the markdown path.
    expect(looksLikeHtmlDocument('<meta name="viewport" content="width=device-width" />')).toBe(
      true,
    )
    expect(looksLikeHtmlDocument("<style>body{color:red}</style><p>x</p>")).toBe(true)
    expect(looksLikeHtmlDocument("<head><title>t</title></head>")).toBe(true)
    expect(looksLikeHtmlDocument("<body><h1>hi</h1></body>")).toBe(true)
  })

  it("skips leading HTML comments; the comment alone never decides", () => {
    expect(looksLikeHtmlDocument("<!-- generated --><!doctype html><html></html>")).toBe(true)
    expect(looksLikeHtmlDocument('<!-- a -->\n<!-- b -->\n<meta charset="utf-8" />')).toBe(true)
    // Markdown that merely opens with a comment stays markdown.
    expect(looksLikeHtmlDocument("<!-- prettier-ignore -->\n# Heading\n\nprose")).toBe(false)
    expect(looksLikeHtmlDocument("<!-- unterminated comment")).toBe(false)
  })

  it("is false for ambiguous fragments — how HTML-flavored Markdown opens", () => {
    // A centered README opens with <div align="center">; a snippet with <p>/<h1>.
    // Rendering those as markdown is correct.
    expect(looksLikeHtmlDocument('<div align="center">fragment</div>')).toBe(false)
    expect(looksLikeHtmlDocument("<p>a paragraph</p>")).toBe(false)
    expect(looksLikeHtmlDocument("<h1>title</h1>")).toBe(false)
    expect(looksLikeHtmlDocument('<?xml version="1.0"?><svg></svg>')).toBe(false)
  })
})

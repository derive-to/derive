import { zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { sha256Hex } from "../src/hash"
import type {
  ArtifactRecord,
  BlobStore,
  MetaStore,
  NewArtifact,
  NewProposal,
  NewVersion,
} from "../src/ports"
import {
  approveProposal,
  artifactUrl,
  type ProposeInput,
  PublishError,
  type PublishInput,
  propose,
  publish,
  toJson,
} from "../src/publish"

// publish()/propose() store content then write the artifact/version. The
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

// A focused in-memory fake: only the handful of methods publish/propose/approve
// actually call, over plain records (no `any`). Cast through MetaStore at the end —
// the uncalled ~75 methods are never reached.
type FakeArtifact = NewArtifact & { current_version: number; created_at: string; removed_at: null }
type FakeVersion = NewVersion & { n: number; artifact_id: string; created_at: string }
type FakeProposal = NewProposal & { state: string; created_at: string }

const makeMeta = (): MetaStore => {
  const byShort = new Map<string, FakeArtifact>()
  const byId = new Map<string, FakeArtifact>()
  const versions = new Map<string, FakeVersion[]>()
  const proposals = new Map<string, FakeProposal>()
  const meta = {
    createArtifact: async (a: NewArtifact): Promise<FakeArtifact> => {
      const rec: FakeArtifact = { ...a, current_version: 0, created_at: "t", removed_at: null }
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
    createProposal: async (p: NewProposal): Promise<FakeProposal> => {
      const rec: FakeProposal = { ...p, state: "open", created_at: "t" }
      proposals.set(p.id, rec)
      return rec
    },
    getProposal: async (id: string) => proposals.get(id) ?? null,
    decideProposal: async (id: string, f: Record<string, unknown>) => {
      const p = proposals.get(id)
      if (p) Object.assign(p, f)
      return p ?? null
    },
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
    expect(artifact.visibility).toBe("link")
    expect(version.n).toBe(1)
    expect(version.content_type).toBe("text/html")
    expect(new TextDecoder().decode((await blobs.get(version.blob_key)) ?? undefined)).toBe(
      "<h1>hi</h1>",
    )
  })

  it("detects markdown by extension", async () => {
    const { version } = await publish(makeMeta(), makeBlobs(), file("# md", { filename: "doc.md" }))
    expect(version.content_type).toBe("text/markdown")
  })

  it("honors explicit title, visibility, and author", async () => {
    const { artifact, version } = await publish(
      makeMeta(),
      makeBlobs(),
      file("x", { title: "Custom", visibility: "public", author: "amy" }),
    )
    expect(artifact.title).toBe("Custom")
    expect(artifact.visibility).toBe("public")
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
    // Title comes from the skill's frontmatter name, not the zip filename.
    expect(artifact.title).toBe("my-skill")
    // A skill carries the distinct content type so the library can badge it for free.
    expect(version.content_type).toBe("derive/skill")
  })

  it("tags a plain docs bundle (no SKILL.md) as a normal derive/bundle", async () => {
    const blobs = makeBlobs()
    const { version } = await publish(
      makeMeta(),
      blobs,
      bundle({ "README.md": "# Docs", "guide.md": "# Guide" }),
    )
    expect(version.content_type).toBe("derive/bundle")
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
})

describe("publish: republish an existing artifact", () => {
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

describe("propose: a candidate version awaiting review", () => {
  const proposeInput = (body: string): ProposeInput => ({
    bytes: new TextEncoder().encode(body),
    filename: "page.html",
    isBundle: false,
    author: "bob",
    message: "tweak",
  })

  it("stores an open proposal against an existing artifact", async () => {
    const meta = makeMeta()
    const blobs = makeBlobs()
    const { artifact } = await publish(meta, blobs, file("v1"))
    const { proposal } = await propose(meta, blobs, artifact.short_id, proposeInput("candidate"))
    expect(proposal.state).toBe("open")
    expect(proposal.author).toBe("bob")
  })

  it("404s when proposing against an unknown artifact", async () => {
    await expect(
      propose(makeMeta(), makeBlobs(), "nope", proposeInput("x")),
    ).rejects.toBeInstanceOf(PublishError)
  })

  it("approveProposal promotes the candidate to the next live version", async () => {
    const meta = makeMeta()
    const blobs = makeBlobs()
    const { artifact } = await publish(meta, blobs, file("v1"))
    const { proposal } = await propose(meta, blobs, artifact.short_id, proposeInput("candidate"))
    const version = await approveProposal(meta, blobs, proposal, "amy", "lgtm")
    expect(version.n).toBe(2)
    expect(version.blob_key).toBe(proposal.blob_key) // reuses the proposal's stored bytes
  })

  it("approveProposal 409s if the proposal isn't open", async () => {
    const meta = makeMeta()
    const blobs = makeBlobs()
    const { artifact } = await publish(meta, blobs, file("v1"))
    const { proposal } = await propose(meta, blobs, artifact.short_id, proposeInput("candidate"))
    await expect(
      approveProposal(meta, blobs, { ...proposal, state: "approved" }, "amy"),
    ).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe("publish: URL + JSON helpers", () => {
  const artifact = {
    short_id: "abc123",
    slug: "my-doc",
    title: "My Doc",
    kind: "file",
    visibility: "link",
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

  it("toJson shapes the public artifact payload", () => {
    const json = toJson("https://derive.test", artifact, [])
    expect(json).toMatchObject({
      short_id: "abc123",
      url: "https://derive.test/artifacts/my-doc-abc123",
      kind: "file",
      spa: false,
      current_version: 2,
    })
  })
})

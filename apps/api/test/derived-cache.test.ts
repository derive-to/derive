import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { elideDataUris, sectionMarkers, toMarkdown } from "@derive/core"
import { FsBlobStore } from "@derive/storage/fs"
import { afterAll, describe, expect, it } from "vitest"
import {
  DERIVED_CACHE_MAX_CHARS,
  DERIVED_CACHE_MIN_CHARS,
  type DerivedViews,
  derivedViewsFor,
} from "../src/lib/derived-cache"

const dir = mkdtempSync(join(tmpdir(), "derive-dcache-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// A minimal in-memory meta for the two cache methods — plus knobs to fail either
// direction, for the best-effort guarantees.
const makeMeta = (opts?: { failGet?: boolean; failPut?: boolean }) => {
  const rows = new Map<string, string>()
  return {
    rows,
    meta: {
      getDerivedView: async (sha: string) => {
        if (opts?.failGet) throw new Error("simulated get failure")
        const blob_key = rows.get(sha)
        return blob_key ? { blob_key } : null
      },
      putDerivedView: async (rec: { source_sha: string; blob_key: string }) => {
        if (opts?.failPut) throw new Error("simulated put failure")
        rows.set(rec.source_sha, rec.blob_key)
      },
    },
  }
}

// A real HTML doc big enough to cross the gate, with structure worth deriving.
const bigHtml = (marker = "alpha") =>
  `<!doctype html><html><head><title>Big</title><style>body{color:red}</style></head><body>` +
  `<h1>Big Doc</h1>` +
  Array.from(
    { length: 1100 },
    (_, i) =>
      `<section aria-label="Part ${i}"><h2>Part ${i}</h2><p>the ${marker} content of part ${i}, long enough to matter and then some padding padding padding.</p></section>`,
  ).join("") +
  `</body></html>`

describe("derivedViewsFor — the lazy content-addressed cache", () => {
  it("gates: too-small, too-large, and non-HTML sources return null and never touch the store", async () => {
    const { meta, rows } = makeMeta()
    const blobs = new FsBlobStore(join(dir, "gate"))
    // Too small — the direct path is already ~free.
    expect(await derivedViewsFor({ meta, blobs }, "<h1>tiny</h1>", "text/html")).toBeNull()
    // Non-HTML — markdown/text are near-passthrough, no round trip earned.
    const bigMd = "# md\n\n".padEnd(DERIVED_CACHE_MIN_CHARS + 10, "x")
    expect(await derivedViewsFor({ meta, blobs }, bigMd, "text/markdown")).toBeNull()
    // Too large — computing + serializing a multi-MB payload would risk the isolate;
    // giant docs fall back to the direct single-view path (no cache, no blob).
    const huge = `<h1>Huge</h1>${"<p>x</p>".repeat(DERIVED_CACHE_MAX_CHARS / 7 + 100)}`
    expect(huge.length).toBeGreaterThan(DERIVED_CACHE_MAX_CHARS)
    expect(await derivedViewsFor({ meta, blobs }, huge, "text/html")).toBeNull()
    expect(rows.size).toBe(0)
  })

  it("miss computes views that are SUBSTITUTION-TRANSPARENT with the direct path, and persists them", async () => {
    const { meta, rows } = makeMeta()
    const blobs = new FsBlobStore(join(dir, "miss"))
    const src = bigHtml()
    expect(src.length).toBeGreaterThan(DERIVED_CACHE_MIN_CHARS)

    const views = await derivedViewsFor({ meta, blobs }, src, "text/html")
    if (!views) throw new Error("expected views for a big HTML doc")
    // Byte-identical to what the read/search paths would compute directly — the
    // whole contract: a cache hit and a direct computation are indistinguishable.
    // Only the two EXPENSIVE views are cached (markdown + source markers); the
    // cheap views (text/outline/landmarks) are computed inline by the callers.
    expect(views.markdown).toBe(elideDataUris(toMarkdown(src, "text/html")))
    expect(views.markers).toEqual(sectionMarkers(src, "text/html"))
    expect(rows.size).toBe(1)
  })

  it("hit is REALLY served from the cache (poisoned-blob proof), and distinct content gets distinct rows", async () => {
    const { meta, rows } = makeMeta()
    const blobs = new FsBlobStore(join(dir, "hit"))
    const src = bigHtml()
    await derivedViewsFor({ meta, blobs }, src, "text/html")

    // Poison the cached blob: overwrite the row to point at a marker payload. If a
    // second call recomputed instead of reading the cache, it would NOT see this.
    const poisoned: DerivedViews = {
      markdown: "POISONED-MARKDOWN",
      markers: [],
    }
    const poisonKey = await blobs.put(new TextEncoder().encode(JSON.stringify(poisoned)))
    const sha = [...rows.keys()][0] as string
    rows.set(sha, poisonKey)

    const second = await derivedViewsFor({ meta, blobs }, src, "text/html")
    expect(second?.markdown).toBe("POISONED-MARKDOWN")

    // Different content — different sha — misses the poisoned row entirely.
    const other = await derivedViewsFor({ meta, blobs }, bigHtml("beta"), "text/html")
    expect(other?.markdown).not.toBe("POISONED-MARKDOWN")
    expect(rows.size).toBe(2)
  })

  it("best-effort both directions: a failing store read falls back to compute; a failing write still returns views", async () => {
    const src = bigHtml()
    const getFail = makeMeta({ failGet: true })
    const v1 = await derivedViewsFor(
      { meta: getFail.meta, blobs: new FsBlobStore(join(dir, "gf")) },
      src,
      "text/html",
    )
    expect(v1?.markdown).toBe(elideDataUris(toMarkdown(src, "text/html")))

    const putFail = makeMeta({ failPut: true })
    const v2 = await derivedViewsFor(
      { meta: putFail.meta, blobs: new FsBlobStore(join(dir, "pf")) },
      src,
      "text/html",
    )
    expect(v2?.markdown).toBe(elideDataUris(toMarkdown(src, "text/html")))
    expect(putFail.rows.size).toBe(0) // nothing persisted, nothing thrown
  })

  it("a corrupt cached blob (bad JSON) falls back to compute instead of throwing", async () => {
    const { meta, rows } = makeMeta()
    const blobs = new FsBlobStore(join(dir, "corrupt"))
    const src = bigHtml()
    await derivedViewsFor({ meta, blobs }, src, "text/html")
    const junkKey = await blobs.put(new TextEncoder().encode("{not json"))
    rows.set([...rows.keys()][0] as string, junkKey)

    const views = await derivedViewsFor({ meta, blobs }, src, "text/html")
    expect(views?.markdown).toBe(elideDataUris(toMarkdown(src, "text/html")))
  })

  it("routes the miss-path persist through `background` when given (edge waitUntil) and still persists (Node inline-await)", async () => {
    const { meta, rows } = makeMeta()
    const blobs = new FsBlobStore(join(dir, "bg"))
    const src = bigHtml()
    // A background that awaits inline — exactly what ctx.background does on Node, so
    // the row is written before the call returns (deterministic for tests + Node).
    const backgrounded: Promise<unknown>[] = []
    const background = async (work: Promise<unknown>) => {
      backgrounded.push(work)
      await work
    }
    const views = await derivedViewsFor({ meta, blobs, background }, src, "text/html")
    expect(views?.markdown).toBe(elideDataUris(toMarkdown(src, "text/html")))
    expect(backgrounded).toHaveLength(1) // the persist was routed through background
    expect(rows.size).toBe(1) // and it completed (Node inline-await)
    // The persist promise never rejects (safe for edge waitUntil to fire-and-forget).
    await expect(backgrounded[0]).resolves.toBeUndefined()
  })

  it("the persist promise NEVER rejects even when the write fails — safe to hand to waitUntil without a catch", async () => {
    const { meta } = makeMeta({ failPut: true })
    const src = bigHtml()
    let handed: Promise<unknown> | undefined
    const background = async (work: Promise<unknown>) => {
      handed = work
      // Deliberately do NOT await here — mimics edge waitUntil registering it to run
      // after the response; the read must not depend on it, and it must not reject.
    }
    const views = await derivedViewsFor(
      { meta, blobs: new FsBlobStore(join(dir, "bgfail")), background },
      src,
      "text/html",
    )
    expect(views?.markdown).toBe(elideDataUris(toMarkdown(src, "text/html"))) // read returns regardless
    await expect(handed).resolves.toBeUndefined() // the write failure was swallowed, not thrown
  })
})

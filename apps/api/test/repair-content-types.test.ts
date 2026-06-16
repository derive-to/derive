import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newId, publish } from "@dock/core"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { FsBlobStore } from "@dock/storage/fs"
import { afterAll, describe, expect, it } from "vitest"
import { repairHtmlMistypedAsMarkdown } from "../src/lib/repair-content-types"

const dir = mkdtempSync(join(tmpdir(), "dock-repair-test-"))
const meta = new SqliteMetaStore(join(dir, "r.db"))
const blobs = new FsBlobStore(join(dir, "blobs"))
const enc = (s: string) => new TextEncoder().encode(s)
const HTML_DOC =
  "<!doctype html>\n<html><head><style>h1{color:red}</style></head><body><h1>Report</h1></body></html>"
const REAL_MD = "# Heading\n\nReal markdown with a bit of <span>inline html</span>."

afterAll(() => {
  meta.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("content-type: publish-time sniff + repair", () => {
  it("publish classifies an HTML document as text/html even with a .md filename", async () => {
    const { version } = await publish(meta, blobs, {
      bytes: enc(HTML_DOC),
      filename: "report.md", // .md name, but the body is a full HTML doc
      isBundle: false,
      orgId: "local",
    })
    expect(version.content_type).toBe("text/html")

    const md = await publish(meta, blobs, {
      bytes: enc(REAL_MD),
      filename: "notes.md",
      isBundle: false,
      orgId: "local",
    })
    expect(md.version.content_type).toBe("text/markdown")
  })

  it("repair reclassifies HTML-bodied markdown versions, leaves real markdown alone", async () => {
    // Seed the legacy bug directly: a version stored as text/markdown whose blob is HTML.
    const key = await blobs.put(enc(HTML_DOC))
    const a = await meta.createArtifact({
      id: newId("a"),
      short_id: "blankdoc",
      org_id: "local",
      slug: null,
      title: "Goal-Agent Frozen Bench",
      visibility: "link",
      kind: "file",
      spa: 0,
    })
    await meta.addVersion(a.id, {
      id: newId("v"),
      blob_key: key,
      content_type: "text/markdown", // the mis-classification
      size_bytes: HTML_DOC.length,
      author: "t",
      message: null,
    })
    expect((await meta.getByShortId("blankdoc"))?.current_content_type).toBe("text/markdown")

    const r = await repairHtmlMistypedAsMarkdown(meta, blobs, { orgId: "local" })
    expect(r.fixed).toBe(1)
    expect(r.items.map((i) => i.short_id)).toContain("blankdoc")

    // Fixed version + artifact now render as HTML; the genuine markdown stays markdown.
    expect((await meta.getByShortId("blankdoc"))?.current_content_type).toBe("text/html")
    const notes = (await meta.listArtifacts({ orgId: "local" })).find((x) => x.title === "notes")
    if (notes) expect(notes.current_content_type).toBe("text/markdown")

    // Idempotent: a second pass fixes nothing.
    expect((await repairHtmlMistypedAsMarkdown(meta, blobs, { orgId: "local" })).fixed).toBe(0)
  })
})

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newId, publish } from "@dock/core"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { FsBlobStore } from "@dock/storage/fs"
import { afterAll, describe, expect, it } from "vitest"

const dir = mkdtempSync(join(tmpdir(), "dock-ctsniff-test-"))
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

describe("content-type: publish-time sniff", () => {
  // The first line of defense: classify by the bytes, not the filename, so a full
  // HTML document under a .md name is never stored as markdown (which would render
  // blank). The renderer also self-defends and self-heals on view (see
  // raw-self-heal.test.ts) — this just keeps new content correct at the source.
  it("classifies an HTML document as text/html even with a .md filename", async () => {
    const { version } = await publish(meta, blobs, {
      bytes: enc(HTML_DOC),
      filename: "report.md", // .md name, but the body is a full HTML doc
      isBundle: false,
      orgId: "local",
    })
    expect(version.content_type).toBe("text/html")
  })

  it("leaves genuine markdown as text/markdown", async () => {
    const { version } = await publish(meta, blobs, {
      bytes: enc(REAL_MD),
      filename: "notes.md",
      isBundle: false,
      orgId: "local",
    })
    expect(version.content_type).toBe("text/markdown")
  })

  it("does not key off a stray id collision", async () => {
    // Sanity: a second HTML publish under a fresh id is still html.
    const { version } = await publish(meta, blobs, {
      bytes: enc(HTML_DOC),
      filename: `doc-${newId("x")}.md`,
      isBundle: false,
      orgId: "local",
    })
    expect(version.content_type).toBe("text/html")
  })
})

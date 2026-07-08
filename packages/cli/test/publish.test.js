import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { collectDir, readTarget } from "../src/publish.js"

const dirs = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "derive-publish-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("collectDir", () => {
  it("keeps .env* out of the upload — anywhere in the tree — and reports it", () => {
    const d = tmp()
    mkdirSync(join(d, "references"))
    writeFileSync(join(d, "MANIFEST.md"), "# m")
    writeFileSync(join(d, ".env"), "SECRET=1")
    writeFileSync(join(d, ".env.production"), "SECRET=2")
    writeFileSync(join(d, ".env.example"), "SECRET=")
    writeFileSync(join(d, "references", ".env"), "SECRET=3")
    writeFileSync(join(d, "references", "schema.md"), "# s")
    const { files, skipped } = collectDir(d)
    expect(Object.keys(files).sort()).toEqual([
      ".env.example",
      "MANIFEST.md",
      "references/schema.md",
    ])
    expect(skipped.sort()).toEqual([".env", ".env.production", "references/.env"])
  })

  it("skipTopDirs drops the runner's clone workspace at the top level only", () => {
    const d = tmp()
    mkdirSync(join(d, "repos", "acme-eda"), { recursive: true })
    mkdirSync(join(d, "references", "repos"), { recursive: true })
    writeFileSync(join(d, "MANIFEST.md"), "# m")
    writeFileSync(join(d, "repos", "acme-eda", "big.md"), "clone contents")
    writeFileSync(
      join(d, "references", "repos", "note.md"),
      "a doc that happens to be named repos/",
    )
    const { files } = collectDir(d, d, undefined, ["repos"])
    expect(Object.keys(files).sort()).toEqual(["MANIFEST.md", "references/repos/note.md"])
  })
})

describe("readTarget", () => {
  it("zips a directory (carrying the skip list) and passes a file through", () => {
    const d = tmp()
    writeFileSync(join(d, "MANIFEST.md"), "# m")
    writeFileSync(join(d, ".env"), "SECRET=1")
    const dir = readTarget(d)
    expect(dir.filename).toMatch(/\.zip$/)
    expect(dir.skipped).toEqual([".env"])
    const file = readTarget(join(d, "MANIFEST.md"))
    expect(file.filename).toBe("MANIFEST.md")
    expect(file.skipped).toEqual([])
  })

  it("rejects a directory with nothing publishable in it", () => {
    const d = tmp()
    writeFileSync(join(d, ".env"), "SECRET=1")
    expect(() => readTarget(d)).toThrow(/empty/)
  })
})

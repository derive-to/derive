import { describe, expect, it } from "vitest"
import { fitRepoBytes, type RepoFile } from "./repo-fit"

const KB = 1024
const file = (path: string, bytes: number, text: boolean): RepoFile => ({
  path,
  bytes: new Uint8Array(bytes),
  text,
})

describe("fitRepoBytes", () => {
  it("keeps everything when the repository already fits", () => {
    const r = fitRepoBytes(
      [file("/code/train.py", 4 * KB, true), file("/code/teaser.png", 200 * KB, false)],
      { cap: 1000 * KB, maxFiles: 100 },
    )
    expect(r.fits).toBe(true)
    expect(Object.keys(r.files).sort()).toEqual(["/code/teaser.png", "/code/train.py"])
    expect(r.dropped).toEqual([])
    expect(r.notes).toEqual([])
  })

  it("keeps all the code and drops the biggest media", () => {
    const r = fitRepoBytes(
      [
        file("/code/train.py", 8 * KB, true),
        file("/code/README.md", 2 * KB, true),
        file("/code/assets/demo.gif", 700 * KB, false),
        file("/code/assets/teaser.gif", 500 * KB, false),
        file("/code/assets/icon.png", 20 * KB, false),
      ],
      { cap: 100 * KB, maxFiles: 100 },
    )
    expect(r.fits).toBe(true)
    expect(Object.keys(r.files).sort()).toEqual([
      "/code/README.md",
      "/code/assets/icon.png",
      "/code/train.py",
    ])
    // Largest first, so the notes name the worst offender first.
    expect(r.dropped.map((f) => f.path)).toEqual([
      "/code/assets/demo.gif",
      "/code/assets/teaser.gif",
    ])
    expect(r.after).toBeLessThanOrEqual(100 * KB)
    expect(r.before).toBe(1230 * KB)
    expect(r.notes[0]).toContain("assets/demo.gif")
    expect(r.notes[0]).toContain("left out 2 large files")
  })

  it("never drops a text file, whatever it costs", () => {
    const r = fitRepoBytes(
      [file("/code/generated.c", 90 * KB, true), file("/code/logo.png", 40 * KB, false)],
      { cap: 100 * KB, maxFiles: 100 },
    )
    expect(r.fits).toBe(true)
    expect(Object.keys(r.files)).toEqual(["/code/generated.c"])
  })

  it("refuses when the code alone is over the budget", () => {
    const r = fitRepoBytes([file("/code/huge.json", 200 * KB, true)], {
      cap: 100 * KB,
      maxFiles: 100,
    })
    expect(r.fits).toBe(false)
    expect(r.files).toEqual({})
    expect(r.notes[0]).toContain("text files alone")
  })

  it("refuses when the code alone is over the file count", () => {
    const many = Array.from({ length: 12 }, (_, i) => file(`/code/f${i}.py`, KB, true))
    expect(fitRepoBytes(many, { cap: 100 * KB, maxFiles: 10 }).fits).toBe(false)
  })

  it("drops media to stay under the file count too", () => {
    const r = fitRepoBytes(
      [
        file("/code/a.py", KB, true),
        file("/code/b.py", KB, true),
        file("/code/x.png", 3 * KB, false),
        file("/code/y.png", 2 * KB, false),
        file("/code/z.png", KB, false),
      ],
      { cap: 100 * KB, maxFiles: 4 },
    )
    expect(r.fits).toBe(true)
    expect(Object.keys(r.files)).toHaveLength(4)
    expect(r.dropped.map((f) => f.path)).toEqual(["/code/x.png"])
  })

  it("names only the first few and counts the rest", () => {
    const r = fitRepoBytes(
      Array.from({ length: 9 }, (_, i) => file(`/code/m${i}.mp4`, (i + 1) * KB, false)),
      { cap: KB, maxFiles: 100 },
    )
    expect(r.dropped).toHaveLength(8)
    expect(r.notes[0]).toContain("and 2 more")
  })
})

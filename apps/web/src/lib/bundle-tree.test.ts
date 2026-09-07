import { describe, expect, it } from "vitest"
import { type BundleTreeNode, buildBundleTree } from "./bundle-tree"

const tex = (path: string) => ({ path, type: "text/x-tex" })
const png = (path: string) => ({ path, type: "image/png" })

// The bar reads names and counts, so that is what the assertions read.
const shape = (nodes: BundleTreeNode[]): unknown[] =>
  nodes.map((n) => (n.kind === "file" ? n.name : { [n.path]: shape(n.children), count: n.count }))

describe("buildBundleTree", () => {
  it("puts the entry first, then root files, then root folders, in server order", () => {
    // Server order is sorted by path, which would put fig/ before main.tex.
    const tree = buildBundleTree(
      [png("fig/a.png"), tex("main.tex"), tex("refs.bib"), tex("sec/method.tex"), tex("zeta.tex")],
      "main.tex",
    )
    expect(shape(tree)).toEqual([
      "main.tex",
      "refs.bib",
      "zeta.tex",
      { fig: ["a.png"], count: 1 },
      { sec: ["method.tex"], count: 1 },
    ])
  })

  it("lists a folder's files before its sub-folders and nests to any depth", () => {
    const tree = buildBundleTree(
      [
        tex("main.tex"),
        tex("sec/app/deep/notes.tex"),
        tex("sec/app/notes.tex"),
        tex("sec/method.tex"),
      ],
      "main.tex",
    )
    expect(shape(tree)).toEqual([
      "main.tex",
      {
        sec: [
          "method.tex",
          { "sec/app": ["notes.tex", { "sec/app/deep": ["notes.tex"], count: 1 }], count: 2 },
        ],
        count: 3,
      },
    ])
  })

  it("counts files at every depth, not immediate children", () => {
    const tree = buildBundleTree(
      [tex("main.tex"), png("fig/a.png"), png("fig/b.png"), png("fig/sub/c.png")],
      "main.tex",
    )
    const fig = tree[1]
    expect(fig?.kind === "folder" && fig.count).toBe(3)
  })

  it("drops a root README.md, whatever its case, but keeps one inside a folder", () => {
    const tree = buildBundleTree(
      [tex("README.md"), tex("main.tex"), tex("sec/readme.md"), tex("sec/method.tex")],
      "main.tex",
    )
    expect(shape(tree)).toEqual(["main.tex", { sec: ["readme.md", "method.tex"], count: 2 }])
    expect(shape(buildBundleTree([tex("readme.MD"), tex("main.tex")], "main.tex"))).toEqual([
      "main.tex",
    ])
  })

  it("keeps the file's full path on a nested node and the bare name for the label", () => {
    const tree = buildBundleTree([tex("main.tex"), png("fig/a.png")], "main.tex")
    const fig = tree[1]
    const a = fig?.kind === "folder" ? fig.children[0] : undefined
    expect(a?.kind === "file" && a.file.path).toBe("fig/a.png")
    expect(a?.kind === "file" && a.name).toBe("a.png")
  })
})

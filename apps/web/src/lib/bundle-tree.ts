/**
 * The shape the paper file bar shows: a bundle's flat, sorted file list folded into the
 * folders it actually has. Every file is reachable from the bar, but a paper carries
 * dozens of figures and a handful of sections, so the root row holds only root files and
 * one chip per root folder; a folder's contents live in the card that chip opens. This
 * is the pure half, so its ordering rules are pinned in bundle-tree.test.ts.
 */

export type BundleTreeFile = { path: string; type: string }

export type BundleTreeNode =
  | { kind: "file"; file: BundleTreeFile; name: string }
  | {
      kind: "folder"
      name: string
      /** Bundle-relative, no trailing slash: `fig`, `sec/app`. */
      path: string
      children: BundleTreeNode[]
      /** Files at any depth, for the chip's count. */
      count: number
    }

// Build-time shape: files and sub-folders kept apart so the final order (files, then
// folders) falls out without a sort, and children keep the server's order within each.
type Draft = {
  name: string
  path: string
  files: BundleTreeNode[]
  folders: Draft[]
  count: number
}

const draft = (name: string, path: string): Draft => ({
  name,
  path,
  files: [],
  folders: [],
  count: 0,
})

const finish = (d: Draft): BundleTreeNode => ({
  kind: "folder",
  name: d.name,
  path: d.path,
  children: [...d.files, ...d.folders.map(finish)],
  count: d.count,
})

/**
 * Root order: the entry first (it is the file most edits touch), then root files, then
 * root folders, each in server order; inside a folder, files before sub-folders. A root
 * README.md is dropped: a paper's README is notes for the repository, not part of the
 * paper, and existing bundles keep the file, it just earns no chip.
 */
export function buildBundleTree(files: BundleTreeFile[], entry: string): BundleTreeNode[] {
  const root = draft("", "")
  let entryNode: BundleTreeNode | undefined
  for (const file of files) {
    const segments = file.path.split("/")
    const name = segments[segments.length - 1] ?? file.path
    if (file.path === entry) {
      entryNode = { kind: "file", file, name }
      continue
    }
    if (segments.length === 1 && name.toLowerCase() === "readme.md") continue
    let folder = root
    for (let depth = 0; depth < segments.length - 1; depth++) {
      const segment = segments[depth] ?? ""
      folder.count++
      let next = folder.folders.find((f) => f.name === segment)
      if (!next) {
        next = draft(segment, segments.slice(0, depth + 1).join("/"))
        folder.folders.push(next)
      }
      folder = next
    }
    folder.count++
    folder.files.push({ kind: "file", file, name })
  }
  return [...(entryNode ? [entryNode] : []), ...root.files, ...root.folders.map(finish)]
}

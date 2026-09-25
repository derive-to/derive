export type PreparedWorkflowFiles = {
  name: string
  entries: Record<string, Uint8Array>
  paths: string[]
  bytes: number
  excluded: string[]
  archive?: File
}
const MAX_BYTES = 50 * 1024 * 1024
const excludedPath = (path: string) =>
  path
    .split("/")
    .some(
      (part) =>
        [".git", "node_modules", ".venv", "__pycache__", ".DS_Store", "__MACOSX"].includes(part) ||
        (/^\.env(?:\.|$)/i.test(part) && !/\.(example|sample|template)$/i.test(part)) ||
        /^(auth\.json|\.?credentials(?:\.json)?|id_(rsa|ed25519|ecdsa)(\.pub)?|.*\.(pem|p12|pfx|key))$/i.test(
          part,
        ),
    )

/** Review local files before transfer. The server independently validates the archive. */
export async function prepareWorkflowFiles(files: File[]): Promise<PreparedWorkflowFiles> {
  if (!files.length) throw new Error("Choose a folder or ZIP")
  const entries: Record<string, Uint8Array> = Object.create(null)
  const excluded: string[] = []
  let total = 0
  const seen = new Set<string>()
  const paths: string[] = []
  const take = (path: string, size: number) => {
    if (excludedPath(path)) {
      excluded.push(path)
      return false
    }
    if (path.endsWith("/")) return false
    if (
      !path ||
      /[\\:]/.test(path) ||
      [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      path.length > 512 ||
      path.split("/").some((p) => !p || p === "." || p === ".." || /[. ]$/.test(p))
    )
      throw new Error(`Unsupported file path: ${path}`)
    if (seen.has(path.toLowerCase())) throw new Error(`Duplicate path: ${path}`)
    seen.add(path.toLowerCase())
    paths.push(path)
    total += size
    if (total > MAX_BYTES || seen.size > 2000)
      throw new Error("Choose up to 2,000 files totaling 50 MB")
    return true
  }
  const first = files[0]
  if (!first) throw new Error("Choose a folder or ZIP")
  let name: string
  let archive: File | undefined
  if (files.length === 1 && !first.webkitRelativePath && /\.zip$/i.test(first.name)) {
    if (first.size > MAX_BYTES) throw new Error("Choose a ZIP smaller than 50 MB")
    name = first.name.replace(/\.zip$/i, "")
    const { unzip } = await import("fflate")
    const bytes = new Uint8Array(await first.arrayBuffer())
    await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
      let failure: unknown
      unzip(
        bytes,
        {
          filter: (entry) => {
            try {
              take(entry.name, entry.originalSize)
              return false // Review metadata only; transfer the original archive for server validation.
            } catch (error) {
              failure = error
              return false
            }
          },
        },
        (error, result) => (error || failure ? reject(error ?? failure) : resolve(result)),
      )
    })
    if (excluded.length)
      throw new Error(
        "Remove credentials and caches from this ZIP, or choose a folder to exclude them automatically.",
      )
    archive = first
  } else {
    name = first.webkitRelativePath.split("/")[0] || "Input files"
    const kept = files
      .map((file) => ({
        file,
        path: file.webkitRelativePath
          ? file.webkitRelativePath.split("/").slice(1).join("/")
          : file.name,
      }))
      .filter(({ file, path }) => take(path, file.size))
    for (const { file, path } of kept) entries[path] = new Uint8Array(await file.arrayBuffer())
  }
  paths.sort()
  if (!paths.length) throw new Error("No files remain after excluding credentials and local caches")
  return { name, entries, paths, bytes: total, excluded, archive }
}
export async function workflowFilesZip(input: PreparedWorkflowFiles): Promise<File> {
  if (input.archive) return input.archive
  const { zip } = await import("fflate")
  const bytes = await new Promise<Uint8Array>((resolve, reject) =>
    zip(input.entries, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data))),
  )
  return new File([bytes as Uint8Array<ArrayBuffer>], `${input.name}.zip`, {
    type: "application/zip",
  })
}

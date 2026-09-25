import type { BundleManifest } from "./ports"

export const FILE_BUNDLE_CONTENT_TYPE = "derive/files"
export const FILE_INPUT_MAX_FILES = 2000
export const FILE_INPUT_MAX_BYTES = 50 * 1024 * 1024

/** Portable relative files only. No normalization that could conceal an unsafe input. */
export function fileInputPathError(path: string): string | null {
  if (
    !path ||
    path.length > 512 ||
    /[\\:]/.test(path) ||
    [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    path.startsWith("/")
  )
    return "Use relative file paths"
  const parts = path.split("/")
  if (parts.some((p) => !p || p === "." || p === ".." || /[. ]$/.test(p))) return "Unsafe file path"
  if (parts.some((p) => [".git", "node_modules", ".venv", "__pycache__"].includes(p)))
    return "Exclude local dependencies and caches"
  const name = parts.at(-1)?.toLowerCase() ?? ""
  if (
    (/^\.env(?:\.|$)/.test(name) && !/\.(example|sample|template)$/.test(name)) ||
    /^(?:auth\.json|credentials(?:\.json)?|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?|.*\.(?:pem|p12|pfx|key))$/.test(
      name,
    )
  )
    return "Use credential bindings for secret files"
  return null
}

/** Check the central directory BEFORE inflation: fflate's decoded map loses duplicates and modes. */
export function validateFileZip(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const fail = (): never => {
    throw new Error("Use a regular ZIP with unique, safe files (no links or encrypted entries)")
  }
  if (bytes.length < 22) fail()
  let end = bytes.length - 22
  while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054b50) end--
  if (end < 0 || end < bytes.length - 65557) fail()
  if (
    end + 22 + view.getUint16(end + 20, true) !== bytes.length ||
    view.getUint32(end + 4, true) !== 0
  )
    fail()
  const count = view.getUint16(end + 10, true)
  if (count !== view.getUint16(end + 8, true) || count > FILE_INPUT_MAX_FILES) fail()
  let offset = view.getUint32(end + 16, true)
  if (offset + view.getUint32(end + 12, true) !== end) fail()
  const centralStart = offset
  const names = new Set<string>()
  let total = 0
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) fail()
    const length = view.getUint16(offset + 28, true)
    const next =
      offset + 46 + length + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true)
    if (next > end || view.getUint16(offset + 8, true) & 1) fail()
    const name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes.subarray(offset + 46, offset + 46 + length),
    )
    const path = name.endsWith("/") ? name.slice(0, -1) : name
    const error = fileInputPathError(path)
    if (error) throw new Error(`${error}: ${path}`)
    const kind = (view.getUint32(offset + 38, true) >>> 16) & 0xf000
    if (kind && kind !== (name.endsWith("/") ? 0x4000 : 0x8000)) fail()
    if (names.has(path.toLowerCase())) fail()
    names.add(path.toLowerCase())
    total += view.getUint32(offset + 24, true)
    if (total > FILE_INPUT_MAX_BYTES) throw new Error("Files exceed 50 MB unpacked")
    const local = view.getUint32(offset + 42, true)
    if (local + 30 > centralStart || view.getUint32(local, true) !== 0x04034b50) fail()
    if (
      view.getUint16(local + 6, true) !== view.getUint16(offset + 8, true) ||
      view.getUint16(local + 8, true) !== view.getUint16(offset + 10, true)
    )
      fail()
    const localLength = view.getUint16(local + 26, true)
    if (
      local +
        30 +
        localLength +
        view.getUint16(local + 28, true) +
        view.getUint32(offset + 20, true) >
      centralStart
    )
      fail()
    const localName = new TextDecoder().decode(bytes.subarray(local + 30, local + 30 + localLength))
    if (localName !== name) fail()
    offset = next
  }
  if (offset !== end) fail()
}

export function fileInputInventory(manifest: BundleManifest) {
  const entries = Object.entries(manifest.files)
  if (!entries.length || entries.length > FILE_INPUT_MAX_FILES)
    throw new Error("Invalid file count")
  let total = 0
  const paths = new Set<string>()
  const files = entries
    .map(([key, file]) => {
      const path = key.startsWith("/") ? key.slice(1) : key
      const error = fileInputPathError(path)
      if (error) throw new Error(error)
      if (
        !/^[a-f0-9]{64}$/.test(file.key) ||
        !Number.isSafeInteger(file.size) ||
        (file.size ?? -1) < 0
      )
        throw new Error("File metadata is unavailable")
      const folded = path.toLowerCase()
      if (paths.has(folded)) throw new Error("Duplicate file path")
      paths.add(folded)
      total += file.size ?? 0
      return { path, sha256: file.key, size: file.size ?? 0 }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
  for (const path of paths) {
    const parts = path.split("/")
    for (let i = 1; i < parts.length; i++)
      if (paths.has(parts.slice(0, i).join("/"))) throw new Error("A file path is also a directory")
  }
  if (total > FILE_INPUT_MAX_BYTES) throw new Error("Files exceed 50 MB unpacked")
  return { files, bytes: total }
}

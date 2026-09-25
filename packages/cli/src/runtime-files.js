import { createHash } from "node:crypto"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const MAX_BYTES = 50 * 1024 * 1024

export class InputFilesError extends Error {}
const invalid = (message) => {
  throw new InputFilesError(message)
}
const directory = async (path) => {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    invalid("The input directory is unsafe. Review the saved environment.")
}

/** Bytes never pass through the model. A completed directory is immutable input, not a workspace overlay. */
export async function prepareRuntimeFiles(cwd, input, download) {
  if (!input) return null
  if (
    !/^[a-zA-Z0-9_-]{1,64}$/.test(input.artifact_id) ||
    !Number.isSafeInteger(input.version) ||
    input.version < 1 ||
    !/^[a-f0-9]{64}$/.test(input.blob_key) ||
    !Array.isArray(input.files) ||
    !input.files.length ||
    input.files.length > 2000
  )
    invalid("The input file inventory is invalid.")
  const files = new Map()
  const folded = new Set()
  let total = 0
  for (const file of input.files) {
    const parts = typeof file.path === "string" ? file.path.split("/") : []
    if (
      !parts.length ||
      file.path.length > 512 ||
      /[\\:]/.test(file.path) ||
      [...file.path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      parts.some((p) => !p || p === "." || p === ".." || /[. ]$/.test(p)) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      folded.has(file.path.toLowerCase())
    )
      invalid("The input file inventory contains an unsafe path or size.")
    files.set(file.path, file)
    folded.add(file.path.toLowerCase())
    total += file.size
  }
  if (total > MAX_BYTES) invalid("Input files exceed the 50 MB limit.")
  for (const path of folded) {
    const parts = path.split("/")
    for (let i = 1; i < parts.length; i++)
      if (folded.has(parts.slice(0, i).join("/")))
        invalid("The input inventory contains conflicting paths.")
  }
  const base = resolve(cwd, ".derive-inputs")
  try {
    await mkdir(base, { mode: 0o700 })
  } catch (error) {
    if (error.code !== "EEXIST") throw error
  }
  await directory(base)
  const destination = join(base, `${input.artifact_id}-v${input.version}-${input.blob_key}`)
  const verify = async () => {
    await directory(destination)
    const seen = new Set()
    const walk = async (path, relative = "") => {
      for (const name of await readdir(path)) {
        const child = join(path, name)
        const key = relative ? `${relative}/${name}` : name
        const stat = await lstat(child)
        if (stat.isSymbolicLink())
          invalid("Saved input files contain a symbolic link. Review the input directory.")
        if (stat.isDirectory()) await walk(child, key)
        else {
          const file = files.get(key)
          if (
            !stat.isFile() ||
            !file ||
            stat.size !== file.size ||
            hash(await readFile(child)) !== file.sha256
          )
            invalid(
              "Saved input files were modified or are incomplete. Review the input directory before retrying.",
            )
          seen.add(key)
        }
      }
    }
    await walk(destination)
    if (seen.size !== files.size)
      invalid("Saved input files are incomplete. Review the input directory before retrying.")
  }
  const existing = await lstat(destination).catch((error) => {
    if (error.code !== "ENOENT") throw error
    return null
  })
  if (existing) {
    await verify()
    return destination
  }
  const temp = await mkdtemp(join(base, ".staging-"))
  try {
    for (const file of files.values()) {
      const response = await download(file.path)
      if (!response.ok || !response.body)
        invalid("Could not download input files. Check the attachment and access, then retry.")
      const chunks = []
      let length = 0
      const reader = response.body.getReader()
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          length += value.byteLength
          if (length > file.size) invalid("An input file exceeded its declared size.")
          chunks.push(value)
        }
      } finally {
        await reader.cancel()
      }
      const bytes = Buffer.concat(chunks)
      if (bytes.length !== file.size || hash(bytes) !== file.sha256)
        invalid("An input file failed verification. The agent was not started.")
      const target = join(temp, file.path)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(target, bytes, { flag: "wx", mode: 0o400 })
    }
    await directory(base)
    await rename(temp, destination)
    await chmod(destination, 0o500)
    return destination
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

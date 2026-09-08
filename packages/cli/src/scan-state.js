import { createHash, randomBytes } from "node:crypto"
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const scanConfigRoot = () =>
  process.env.DERIVE_CONFIG_DIR ?? join(homedir(), ".config", "derive")

// Only a missing file means an empty store. Never overwrite unreadable state.
export const readScanJson = (path, fallback) => {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"))
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("expected a JSON object")
    return value
  } catch (error) {
    if (error.code === "ENOENT") return fallback
    throw new Error(`cannot read ${path}: ${error.message}`)
  }
}

export const writeScanJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

export const sourceCheckpoint = (path, offset) => {
  const length = Math.min(4096, offset)
  const digest = createHash("sha256")
  if (length === 0) return digest.update("").digest("hex")
  const buffer = Buffer.alloc(length)
  const descriptor = openSync(path, "r")
  try {
    const read = readSync(descriptor, buffer, 0, length, offset - length)
    return digest.update(buffer.subarray(0, read)).digest("hex")
  } finally {
    closeSync(descriptor)
  }
}

// Hold the lock for the entire scan/spool/upload transaction. Each parser owns
// separate state, so the generic command can invoke the Skill scanner safely.
export const acquireScanLock = (kind) => {
  const path = join(scanConfigRoot(), `${kind}-scan.lock`)
  mkdirSync(dirname(path), { recursive: true })
  let descriptor
  try {
    descriptor = openSync(path, "wx", 0o600)
  } catch (error) {
    if (error.code !== "EEXIST") throw error
    throw new Error(
      `${kind} scan is locked at ${path}; retry after the other scan exits. If it was killed, remove this lock only after confirming its recorded PID is no longer running.`,
    )
  }
  writeFileSync(
    descriptor,
    JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }),
  )
  closeSync(descriptor)
  let released = false
  const release = () => {
    if (released) return
    released = true
    unlinkSync(path)
    process.off("exit", release)
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", terminate)
  }
  const interrupt = () => {
    release()
    process.exit(130)
  }
  const terminate = () => {
    release()
    process.exit(143)
  }
  process.once("exit", release)
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", terminate)
  return release
}

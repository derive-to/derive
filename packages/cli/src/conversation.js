import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { checkpointFileAllowed as allowed, checkpointProblem } from "./conversation-format.js"

const SESSION_ID = /^[a-zA-Z0-9_-]{1,200}$/
const MAX_BYTES = 8_000_000

export function restoreConversation(home, previous, provider) {
  if (!previous) return
  const checkpoint = previous.checkpoint
  if (
    checkpoint?.provider !== provider ||
    checkpoint.session_id !== previous.session_id ||
    checkpoint.version !== 1 ||
    !checkpoint.files ||
    !Object.keys(checkpoint.files).length
  )
    throw Object.assign(new Error("The native conversation checkpoint is unavailable."), {
      retryable: false,
    })
  const problem = checkpointProblem(checkpoint)
  if (problem) throw Object.assign(new Error(problem), { retryable: false })
  const serialized = JSON.stringify(checkpoint.files)
  if (
    Buffer.byteLength(serialized) > MAX_BYTES ||
    createHash("sha256").update(serialized).digest("hex") !== checkpoint.sha256
  )
    throw Object.assign(new Error("The native conversation checkpoint is corrupt."), {
      retryable: false,
    })
  for (const [file, body] of Object.entries(checkpoint.files)) {
    if (!allowed(provider, previous.session_id, file) || typeof body !== "string")
      throw Object.assign(new Error("The checkpoint contains an unsupported file."), {
        retryable: false,
      })
    const target = join(home, file)
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    writeFileSync(target, body, { mode: 0o600 })
  }
}

/** The newest native conversation in a model home: what an interactive session just wrote,
 *  since the harness picks its own id. Null when there is none. */
export function latestSessionId(home, provider) {
  const root = join(home ?? "", provider === "codex" ? "sessions" : "projects")
  if (!home || !existsSync(root)) return null
  let newest = null
  const walk = (dir, depth = 0) => {
    if (depth > 5) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const mtime = statSync(full).mtimeMs
        if (!newest || mtime > newest.mtime) newest = { name: entry.name, mtime }
      }
    }
  }
  walk(root)
  if (!newest) return null
  // Claude names the file by its session id; Codex ends its rollout file with it.
  const id =
    provider === "codex"
      ? /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(
          newest.name,
        )?.[1]
      : newest.name.slice(0, -".jsonl".length)
  return id && SESSION_ID.test(id) ? id : null
}

export function checkpointConversation(home, provider, session) {
  if (!home || !session || !SESSION_ID.test(session)) return null
  const root = join(home, provider === "codex" ? "sessions" : "projects")
  if (!existsSync(root)) return null
  const files = {}
  let bytes = 0
  const walk = (dir, depth = 0) => {
    if (depth > 5) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile()) {
        const path = relative(home, full)
        if (!allowed(provider, session, path)) continue
        const body = readFileSync(full, "utf8")
        bytes += Buffer.byteLength(body)
        if (bytes > MAX_BYTES) throw new Error("The conversation exceeds the checkpoint limit.")
        files[path] = body
      }
    }
  }
  walk(root)
  if (!Object.keys(files).length) return null
  const checkpoint = {
    version: 1,
    provider,
    session_id: session,
    files,
    sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  }
  const problem = checkpointProblem(checkpoint)
  if (problem) throw new Error(problem)
  return checkpoint
}

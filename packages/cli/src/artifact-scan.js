import { createHash, randomBytes } from "node:crypto"
import {
  closeSync,
  createReadStream,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { discoverSkillLogSources, parseSince } from "./skill-scan.js"

export const ARTIFACT_SCAN_PARSER_VERSION = 1

const configRoot = () => process.env.DERIVE_CONFIG_DIR ?? join(homedir(), ".config", "derive")
const statePath = () => join(configRoot(), "artifact-scan.json")
const spoolPath = () => join(configRoot(), "artifact-scan-spool.json")
const hash = (value) => createHash("sha256").update(value).digest("hex")

const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return fallback
  }
}

const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

const sourceIdentity = (stats) => `${stats.dev}:${stats.ino}`

const sourceCheckpoint = (path, offset) => {
  const length = Math.min(4096, offset)
  if (length === 0) return hash("")
  const buffer = Buffer.alloc(length)
  const descriptor = openSync(path, "r")
  try {
    const read = readSync(descriptor, buffer, 0, length, offset - length)
    return hash(buffer.subarray(0, read))
  } finally {
    closeSync(descriptor)
  }
}

const completeLines = async (path, start, onLine) => {
  let carry = Buffer.alloc(0)
  let consumed = start
  for await (const chunk of createReadStream(path, { start })) {
    const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk
    let lineStart = 0
    let index = bytes.indexOf(10, lineStart)
    while (index !== -1) {
      const line = bytes.subarray(lineStart, index)
      consumed += index + 1 - lineStart
      lineStart = index + 1
      if (line.length) await onLine(line)
      index = bytes.indexOf(10, lineStart)
    }
    carry = bytes.subarray(lineStart)
  }
  return consumed
}

const timestampOf = (record) => {
  const value = record?.timestamp ?? record?.created_at ?? record?.payload?.timestamp
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

const operationForName = (name) => {
  const match = /^mcp__derive__(read|catch_up|publish)$/.exec(String(name ?? ""))
  return match?.[1] ?? null
}

const operationsFromCall = (name, raw) => {
  const direct = operationForName(name)
  if (direct) return [direct]
  if (!["exec", "functions.exec"].includes(name) || typeof raw !== "string") return []
  const found = []
  const pattern = /tools\.mcp__derive__(read|catch_up|publish)\s*\(/g
  for (const match of raw.matchAll(pattern)) found.push(match[1])
  return [...new Set(found)]
}

const outputStrings = (value) => {
  if (typeof value === "string") return [value]
  if (!Array.isArray(value)) return []
  return value.flatMap((item) =>
    item && typeof item === "object" && typeof item.text === "string" ? [item.text] : [],
  )
}

const positiveVersion = (value) => {
  if (Number.isSafeInteger(value) && value > 0) return value
  const match = /^(\d+)(?: \(current\))?$/.exec(String(value ?? ""))
  const parsed = match ? Number(match[1]) : 0
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

const addArtifactResult = (found, value, expected) => {
  if (!value || typeof value !== "object") return
  if (value.isError === true || value.is_error === true || value.error || value.published === false)
    return
  if (Array.isArray(value)) {
    for (const item of value) addArtifactResult(found, item, expected)
    return
  }
  if (typeof value.text === "string") extractArtifactResults(value.text, expected, found)
  if (Array.isArray(value.content)) addArtifactResult(found, value.content, expected)
  const shortId = typeof value.short_id === "string" ? value.short_id : null
  const version = positiveVersion(value.version ?? value.to_version ?? value.to ?? value.head)
  if (!shortId || !version) return
  const action =
    value.published === true || (expected.length === 1 && expected[0] === "publish")
      ? "published"
      : "read"
  found.set(`${action}\0${shortId}\0${version}`, {
    artifact_short_id: shortId,
    artifact_version: version,
    action,
  })
}

function extractArtifactResults(text, expected, found = new Map()) {
  const trimmed = String(text ?? "").trim()
  if (!trimmed) return found
  try {
    addArtifactResult(found, JSON.parse(trimmed), expected)
    return found
  } catch {
    // Tool wrappers can prefix a JSON content block with timing output. Parse each JSON line.
    for (const line of trimmed.split("\n")) {
      try {
        addArtifactResult(found, JSON.parse(line), expected)
      } catch {
        /* use the bounded text receipts below */
      }
    }
  }
  if (!expected.includes("publish")) {
    const yaml = /(?:^|\n)short_id:\s*([a-z0-9_-]+)[\s\S]{0,300}?(?:^|\n)version:\s*(\d+)/m.exec(
      trimmed,
    )
    if (yaml)
      found.set(`read\0${yaml[1]}\0${yaml[2]}`, {
        artifact_short_id: yaml[1],
        artifact_version: Number(yaml[2]),
        action: "read",
      })
    const rendered = /(?:render(?::\w+)? of|artifact) ["']([a-z0-9_-]+)["'] v(\d+)/i.exec(trimmed)
    if (rendered)
      found.set(`read\0${rendered[1]}\0${rendered[2]}`, {
        artifact_short_id: rendered[1],
        artifact_version: Number(rendered[2]),
        action: "read",
      })
  }
  return found
}

const eventFor = ({ client, session, callId, result, occurredAt }) => ({
  event_id: hash(
    [
      "derive-artifact-scan-v1",
      client,
      session,
      callId,
      result.action,
      result.artifact_short_id,
      result.artifact_version,
    ].join("\0"),
  ),
  ...result,
  client,
  evidence: "structured_tool_result",
  opaque_session_id: hash(["derive-artifact-session-v1", client, session].join("\0")),
  occurred_at: occurredAt ?? new Date().toISOString(),
  _timestamp_known: occurredAt !== null && occurredAt !== undefined,
})

const defaultState = () => ({
  version: 1,
  parser_version: ARTIFACT_SCAN_PARSER_VERSION,
  sources: {},
  sessions: { claude: {}, codex: {} },
  pending: { claude: {}, codex: {} },
  initialized_clients: { claude: false, codex: false },
  last_scan_at: null,
})

const pendingKey = (context, callId) =>
  hash(["derive-artifact-pending-v1", context.source, context.session, callId].join("\0"))

const rememberCall = (state, client, callId, operations, context, occurredAt, observedAt) => {
  if (!callId || operations.length === 0) return
  state.pending[client][pendingKey(context, callId)] = {
    operations,
    session: context.session,
    turn: context.turn,
    occurred_at: occurredAt,
    observed_at: observedAt,
  }
}

const completeCall = (
  state,
  events,
  client,
  context,
  callId,
  output,
  occurredAt,
  failed = false,
) => {
  const key = pendingKey(context, callId)
  const legacyKey = Object.hasOwn(state.pending[client], key) ? key : callId
  const pending = state.pending[client][legacyKey]
  if (!pending) return
  delete state.pending[client][legacyKey]
  if (failed) return
  const found = new Map()
  for (const text of outputStrings(output)) extractArtifactResults(text, pending.operations, found)
  for (const result of found.values()) {
    const event = eventFor({
      client,
      session: pending.session,
      callId,
      result,
      occurredAt: occurredAt ?? pending.occurred_at,
    })
    events.set(event.event_id, event)
  }
}

const parseCodexRecord = (record, state, context, events, observedAt) => {
  const payload = record?.payload
  if (record?.type === "turn_context" && payload?.turn_id) context.turn = payload.turn_id
  if (record?.type === "session_meta" && payload?.id) context.session = payload.id
  if (record?.type === "event_msg" && payload?.turn_id) context.turn = payload.turn_id
  if (record?.type !== "response_item") return
  if (["function_call", "custom_tool_call"].includes(payload?.type)) {
    const raw = payload.arguments ?? payload.input
    rememberCall(
      state,
      "codex",
      payload.call_id,
      operationsFromCall(payload.name, raw),
      context,
      timestampOf(record),
      observedAt,
    )
  } else if (["function_call_output", "custom_tool_call_output"].includes(payload?.type)) {
    completeCall(
      state,
      events,
      "codex",
      context,
      payload.call_id,
      payload.output,
      timestampOf(record),
    )
  }
}

const claudeBlocks = (record) => {
  const content = record?.message?.content ?? record?.content
  return Array.isArray(content) ? content : []
}

const parseClaudeRecord = (record, state, context, events, observedAt) => {
  if (record?.sessionId) context.session = record.sessionId
  if (record?.type === "user") context.turn = record.promptId ?? record.uuid ?? context.turn
  for (const block of claudeBlocks(record)) {
    if (block?.type === "tool_use") {
      rememberCall(
        state,
        "claude",
        block.id,
        operationsFromCall(block.name, JSON.stringify(block.input ?? {})),
        context,
        timestampOf(record),
        observedAt,
      )
    } else if (block?.type === "tool_result") {
      const output = typeof block.content === "string" ? block.content : (block.content ?? [])
      completeCall(
        state,
        events,
        "claude",
        context,
        block.tool_use_id,
        output,
        timestampOf(record),
        block.is_error === true,
      )
    }
  }
}

export async function scanArtifactLogs(options = {}) {
  const home = options.home ?? homedir()
  const now = options.now ?? Date.now()
  const sinceMs = parseSince(options.since, now)
  const state = readJson(statePath(), defaultState())
  state.sources ??= {}
  state.sessions ??= { claude: {}, codex: {} }
  state.pending ??= { claude: {}, codex: {} }
  state.pending.claude ??= {}
  state.pending.codex ??= {}
  state.initialized_clients ??= {
    claude: Boolean(state.last_scan_at),
    codex: Boolean(state.last_scan_at),
  }
  const sources = (options.sources ?? discoverSkillLogSources(home)).filter(
    (item) => !options.client || item.client === options.client,
  )
  const events = new Map()
  const scannedAt = new Date(now).toISOString()
  const coverage = {
    claude: { client: "claude", source_files: 0, records_scanned: 0, matched_events: 0 },
    codex: { client: "codex", source_files: 0, records_scanned: 0, matched_events: 0 },
  }

  for (const source of sources) {
    let stats
    try {
      stats = statSync(source.path)
    } catch {
      continue
    }
    if (sinceMs !== null && stats.mtimeMs < sinceMs) continue
    const identity = sourceIdentity(stats)
    const saved = state.sources[source.path]
    let start = 0
    if (sinceMs === null) {
      if (
        saved?.identity === identity &&
        saved.offset <= stats.size &&
        saved.checkpoint_hash === sourceCheckpoint(source.path, saved.offset)
      )
        start = saved.offset
      else if (
        options.baseline ||
        (options.initialBaseline !== false && !state.initialized_clients[source.client])
      )
        start = stats.size
    }
    coverage[source.client].source_files++
    const context =
      start > 0 && saved?.identity === identity
        ? {
            source: source.path,
            session: saved.session ?? basename(source.path, ".jsonl"),
            turn: saved.turn ?? null,
          }
        : { source: source.path, session: basename(source.path, ".jsonl"), turn: null }
    const end = await completeLines(source.path, start, async (lineBytes) => {
      coverage[source.client].records_scanned++
      let record
      try {
        record = JSON.parse(lineBytes.toString("utf8").replace(/\r$/, ""))
      } catch {
        return
      }
      if (source.client === "codex") parseCodexRecord(record, state, context, events, scannedAt)
      else parseClaudeRecord(record, state, context, events, scannedAt)
    })
    const sessionHash = hash(
      ["derive-artifact-session-v1", source.client, context.session].join("\0"),
    )
    state.sessions[source.client][sessionHash] = new Date(stats.mtimeMs).toISOString()
    state.sources[source.path] = {
      identity,
      offset: end,
      client: source.client,
      session: context.session,
      turn: context.turn,
      checkpoint_hash: sourceCheckpoint(source.path, end),
    }
  }

  const cutoff = now - 90 * 86_400_000
  for (const client of ["claude", "codex"])
    for (const [session, seenAt] of Object.entries(state.sessions[client]))
      if (Date.parse(seenAt) < cutoff) delete state.sessions[client][session]
  for (const client of ["claude", "codex"])
    for (const [key, pending] of Object.entries(state.pending[client])) {
      const seenAt = Date.parse(pending.observed_at ?? pending.occurred_at ?? "")
      if (Number.isFinite(seenAt) && seenAt < cutoff) delete state.pending[client][key]
    }

  const matchedEvents = [...events.values()].filter(
    (event) =>
      sinceMs === null || (event._timestamp_known && Date.parse(event.occurred_at) >= sinceMs),
  )
  for (const event of matchedEvents) coverage[event.client].matched_events++
  const coverageRows = Object.values(coverage)
    .filter((row) => row.source_files > 0)
    .map((row) => ({
      ...row,
      sessions_scanned: Object.keys(state.sessions[row.client]).length,
      parser_version: ARTIFACT_SCAN_PARSER_VERSION,
      scanned_at: scannedAt,
    }))
  state.parser_version = ARTIFACT_SCAN_PARSER_VERSION
  for (const client of options.client ? [options.client] : ["claude", "codex"])
    state.initialized_clients[client] = true
  state.last_scan_at = scannedAt
  if (!options.dryRun && !options.deferCommit) writeJson(statePath(), state)
  return {
    events: matchedEvents.map(({ _timestamp_known: _timestampKnown, ...event }) => event),
    coverage: coverageRows,
    state,
    sources,
  }
}

export function commitArtifactScanState(state) {
  writeJson(statePath(), state)
}

export function readArtifactScanSpool() {
  const path = spoolPath()
  try {
    const spool = JSON.parse(readFileSync(path, "utf8"))
    if (spool?.version !== 1 || !Array.isArray(spool.pending) || !Array.isArray(spool.coverage))
      throw new Error("unsupported or malformed spool")
    return spool
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, pending: [], coverage: [] }
    throw new Error(`cannot read artifact scan spool at ${path}: ${error.message}`)
  }
}

export function addToArtifactScanSpool(events, coverage, target) {
  const spool = readArtifactScanSpool()
  const pending = new Map(
    (spool.pending ?? []).map((event) => [
      event.event_id,
      event.retry_unavailable ? { ...event, target, retry_unavailable: false } : event,
    ]),
  )
  for (const event of events) pending.set(event.event_id, { ...event, target })
  const next = { version: 1, pending: [...pending.values()], coverage, target }
  writeJson(spoolPath(), next)
  return next
}

export function markArtifactScanUnavailable(eventIds) {
  const spool = readArtifactScanSpool()
  const unavailable = new Set(eventIds)
  const next = {
    ...spool,
    pending: spool.pending.map((event) =>
      unavailable.has(event.event_id) ? { ...event, retry_unavailable: true } : event,
    ),
  }
  writeJson(spoolPath(), next)
  return next
}

export function removeFromArtifactScanSpool(eventIds, clearCoverage = false) {
  const spool = readArtifactScanSpool()
  const sent = new Set(eventIds)
  const next = {
    ...spool,
    pending: spool.pending.filter((event) => !sent.has(event.event_id)),
    coverage: clearCoverage ? [] : spool.coverage,
  }
  writeJson(spoolPath(), next)
  return next
}

export function artifactScanStatus(home = homedir(), { all = false } = {}) {
  const state = readJson(statePath(), defaultState())
  const spool = readArtifactScanSpool()
  const sources = discoverSkillLogSources(home)
  return {
    parser_version: ARTIFACT_SCAN_PARSER_VERSION,
    last_scan_at: state.last_scan_at ?? null,
    pending: spool.pending.length,
    pending_by_reason: {
      artifact_unavailable: spool.pending.filter((event) => event.retry_unavailable).length,
      awaiting_upload: spool.pending.filter((event) => !event.retry_unavailable).length,
    },
    pending_receipts: spool.pending.slice(0, all ? undefined : 20).map((event) => ({
      artifact_short_id: event.artifact_short_id,
      artifact_version: event.artifact_version,
      action: event.action,
      client: event.client,
      occurred_at: event.occurred_at,
      reason: event.retry_unavailable ? "artifact_unavailable" : "awaiting_upload",
    })),
    pending_receipts_remaining: all ? 0 : Math.max(0, spool.pending.length - 20),
    sources: ["claude", "codex"].map((client) => ({
      client,
      files: sources.filter((item) => item.client === client).length,
      tracked: Object.values(state.sources ?? {}).filter((item) => item.client === client).length,
      sessions_90d: Object.keys(state.sessions?.[client] ?? {}).length,
    })),
  }
}

export const artifactScanInternals = { extractArtifactResults, operationsFromCall }

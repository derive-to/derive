import { createHash, randomBytes } from "node:crypto"
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

export const SKILL_SCAN_PARSER_VERSION = 1

const configRoot = () => process.env.DERIVE_CONFIG_DIR ?? join(homedir(), ".config", "derive")
const installsPath = () => join(configRoot(), "skill-installs.json")
const scanStatePath = () => join(configRoot(), "skill-scan.json")
const spoolPath = () => join(configRoot(), "skill-scan-spool.json")

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

const hash = (value) => createHash("sha256").update(value).digest("hex")

const installKey = (install) =>
  [install.server, install.workspace_id ?? "", install.client, resolve(install.path)].join("\0")

export function listSkillInstalls() {
  const data = readJson(installsPath(), { version: 1, installs: [] })
  return Array.isArray(data.installs) ? data.installs.filter((item) => !item.removed_at) : []
}

export function recordSkillInstall(install) {
  const data = readJson(installsPath(), { version: 1, installs: [] })
  const installs = Array.isArray(data.installs) ? data.installs : []
  const normalized = {
    id: install.id,
    version: install.version,
    name: install.name,
    client: install.client,
    path: resolve(install.path),
    digest: install.digest,
    scope: install.scope,
    server: install.server,
    workspace_id: install.workspaceId ?? null,
    account_id: install.accountId ?? null,
    updated_at: new Date().toISOString(),
  }
  const key = installKey(normalized)
  const next = installs.filter((item) => installKey(item) !== key)
  next.push(normalized)
  writeJson(installsPath(), { version: 1, installs: next })
  return normalized
}

export function removeSkillInstall({ client, path, server, workspaceId }) {
  const data = readJson(installsPath(), { version: 1, installs: [] })
  const target = resolve(path)
  const now = new Date().toISOString()
  const installs = (Array.isArray(data.installs) ? data.installs : []).map((item) =>
    item.client === client &&
    resolve(item.path) === target &&
    item.server === server &&
    (item.workspace_id ?? null) === (workspaceId ?? null)
      ? { ...item, removed_at: now, updated_at: now }
      : item,
  )
  writeJson(installsPath(), { version: 1, installs })
}

export function parseSince(value, now = Date.now()) {
  if (!value) return null
  const relative = /^(\d+)([mhdw])$/.exec(String(value).trim())
  if (relative) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[relative[2]]
    return now - Number(relative[1]) * unit
  }
  const absolute = Date.parse(value)
  if (!Number.isFinite(absolute)) throw new Error("--since must be an ISO date or a value like 30d")
  return absolute
}

const walk = (root, suffix) => {
  if (!existsSync(root)) return []
  const found = []
  const pending = [root]
  while (pending.length) {
    const dir = pending.pop()
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile() && entry.name.endsWith(suffix)) found.push(path)
    }
  }
  return found
}

export function discoverSkillLogSources(home = homedir()) {
  return [
    ...walk(join(home, ".codex", "sessions"), ".jsonl").map((path) => ({ client: "codex", path })),
    ...walk(join(home, ".codex", "archived_sessions"), ".jsonl").map((path) => ({
      client: "codex",
      path,
    })),
    ...walk(join(home, ".claude", "projects"), ".jsonl").map((path) => ({
      client: "claude",
      path,
    })),
  ]
}

const installAliases = (install) => {
  const dir = basename(install.path).toLowerCase()
  const name = String(install.name ?? "")
    .replace(/^\//, "")
    .toLowerCase()
  return new Set([dir, name].filter(Boolean))
}

const codexPatterns = (install) => {
  const path = resolve(install.path).replaceAll("\\", "/").toLowerCase()
  const dir = basename(path)
  return [`${path}/skill.md`, `.agents/skills/${dir}/skill.md`, `.codex/skills/${dir}/skill.md`]
}

const timestampOf = (record) => {
  const value = record?.timestamp ?? record?.created_at ?? record?.payload?.timestamp
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

const sourceIdentity = (stats) => `${stats.dev}:${stats.ino}`

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

const eventFor = ({ install, client, session, turn, occurredAt, evidence }) => ({
  event_id: hash(["derive-skill-scan-v1", client, session, turn, install.id].join("\0")),
  skill_short_id: install.id,
  skill_version: install.version,
  ...(install.digest ? { skill_digest: install.digest } : {}),
  client,
  stage: "loaded",
  evidence,
  opaque_session_id: hash(["derive-skill-session-v1", client, session].join("\0")),
  occurred_at: occurredAt ?? new Date().toISOString(),
  target: {
    server: install.server,
    workspace_id: install.workspace_id ?? null,
    account_id: install.account_id ?? null,
  },
})

const parseClaudeLine = (record, context, installs, sinceMs) => {
  if (record?.type === "user") context.turn = record.promptId ?? record.uuid ?? context.turn
  const attribution =
    typeof record?.attributionSkill === "string"
      ? record.attributionSkill.replace(/^\//, "").toLowerCase()
      : null
  if (!attribution) return []
  const occurredAt = timestampOf(record)
  if (sinceMs !== null && occurredAt && Date.parse(occurredAt) < sinceMs) return []
  return installs
    .filter((install) => installAliases(install).has(attribution))
    .map((install) =>
      eventFor({
        install,
        client: "claude",
        session: record.sessionId ?? context.session,
        turn: context.turn ?? record.parentUuid ?? record.uuid,
        occurredAt,
        evidence: "structured_log",
      }),
    )
}

const codexToolText = (payload) => {
  if (!payload || !["function_call", "custom_tool_call"].includes(payload.type)) return ""
  const value = payload.arguments ?? payload.input
  return typeof value === "string" ? value.toLowerCase() : JSON.stringify(value ?? "").toLowerCase()
}

const parseCodexLine = (record, context, installs, sinceMs) => {
  const payload = record?.payload
  if (record?.type === "turn_context" && payload?.turn_id) context.turn = payload.turn_id
  if (record?.type === "session_meta" && payload?.id) context.session = payload.id
  if (record?.type === "event_msg" && payload?.turn_id) context.turn = payload.turn_id
  const text = record?.type === "response_item" ? codexToolText(payload) : ""
  if (!text) return []
  const occurredAt = timestampOf(record)
  if (sinceMs !== null && occurredAt && Date.parse(occurredAt) < sinceMs) return []
  return installs
    .filter((install) => codexPatterns(install).some((pattern) => text.includes(pattern)))
    .map((install) =>
      eventFor({
        install,
        client: "codex",
        session: context.session,
        turn: context.turn ?? payload.call_id ?? payload.id,
        occurredAt,
        evidence: "skill_file_read",
      }),
    )
}

const defaultState = () => ({
  version: 1,
  parser_version: SKILL_SCAN_PARSER_VERSION,
  sources: {},
  sessions: { claude: {}, codex: {} },
  last_scan_at: null,
})

const targetKey = (target) =>
  [target.server, target.workspace_id ?? "", target.account_id ?? ""].join("\0")

export async function scanSkillLogs(options = {}) {
  const home = options.home ?? homedir()
  const now = options.now ?? Date.now()
  const sinceMs = parseSince(options.since, now)
  const installs = (options.installs ?? listSkillInstalls()).filter(
    (item) => !options.client || item.client === options.client,
  )
  const state = readJson(scanStatePath(), defaultState())
  state.sources ??= {}
  state.sessions ??= { claude: {}, codex: {} }
  state.sessions.claude ??= {}
  state.sessions.codex ??= {}
  const sources = (options.sources ?? discoverSkillLogSources(home)).filter(
    (item) => !options.client || item.client === options.client,
  )
  const events = new Map()
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
      if (saved?.identity === identity && saved.offset <= stats.size) start = saved.offset
      else if (options.baseline) start = stats.size
    }
    coverage[source.client].source_files++
    if (start === stats.size) {
      state.sources[source.path] = { identity, offset: stats.size, client: source.client }
      continue
    }
    // A session header is normally written once, before later turns. Keep the
    // parser context beside the byte offset so an incremental scan can attribute
    // a newly appended tool call to that same session and turn.
    const context =
      start > 0 && saved?.identity === identity
        ? {
            session: saved.session ?? basename(source.path, ".jsonl"),
            turn: saved.turn ?? null,
          }
        : { session: basename(source.path, ".jsonl"), turn: null }
    const clientInstalls = installs.filter((install) => install.client === source.client)
    const end = await completeLines(source.path, start, async (lineBytes) => {
      coverage[source.client].records_scanned++
      const relevant =
        source.client === "claude"
          ? lineBytes.includes('"attributionSkill"') || lineBytes.includes('"type":"user"')
          : lineBytes.includes('"type":"session_meta"') ||
            lineBytes.includes('"type":"turn_context"') ||
            lineBytes.includes("SKILL.md") ||
            lineBytes.includes("skill.md")
      if (!relevant) return
      let record
      try {
        record = JSON.parse(lineBytes.toString("utf8").replace(/\r$/, ""))
      } catch {
        return
      }
      const found =
        source.client === "claude"
          ? parseClaudeLine(record, context, clientInstalls, sinceMs)
          : parseCodexLine(record, context, clientInstalls, sinceMs)
      for (const event of found) events.set(event.event_id, event)
    })
    const sessionHash = hash(["derive-skill-session-v1", source.client, context.session].join("\0"))
    state.sessions[source.client][sessionHash] = new Date(stats.mtimeMs).toISOString()
    state.sources[source.path] = {
      identity,
      offset: end,
      client: source.client,
      session: context.session,
      turn: context.turn,
    }
  }

  const cutoff = now - 90 * 86_400_000
  for (const client of ["claude", "codex"])
    for (const [session, seenAt] of Object.entries(state.sessions[client]))
      if (Date.parse(seenAt) < cutoff) delete state.sessions[client][session]

  for (const event of events.values()) coverage[event.client].matched_events++
  const scannedAt = new Date(now).toISOString()
  const coverageRows = Object.values(coverage)
    .filter((row) => row.source_files > 0)
    .map((row) => ({
      ...row,
      sessions_scanned: Object.keys(state.sessions[row.client]).length,
      parser_version: SKILL_SCAN_PARSER_VERSION,
      scanned_at: scannedAt,
    }))
  state.parser_version = SKILL_SCAN_PARSER_VERSION
  state.last_scan_at = scannedAt

  if (!options.dryRun) writeJson(scanStatePath(), state)
  return { events: [...events.values()], coverage: coverageRows, state, sources }
}

export function addToSkillScanSpool(events, coverage) {
  const spool = readJson(spoolPath(), { version: 1, pending: [], coverage: [] })
  const pending = new Map((spool.pending ?? []).map((event) => [event.event_id, event]))
  for (const event of events) pending.set(event.event_id, event)
  const coverageByClient = new Map((spool.coverage ?? []).map((row) => [row.client, row]))
  for (const row of coverage) coverageByClient.set(row.client, row)
  const next = {
    version: 1,
    pending: [...pending.values()],
    coverage: [...coverageByClient.values()],
  }
  writeJson(spoolPath(), next)
  return next
}

export function readSkillScanSpool() {
  return readJson(spoolPath(), { version: 1, pending: [], coverage: [] })
}

export function removeFromSkillScanSpool(eventIds, clients = []) {
  const spool = readSkillScanSpool()
  const sent = new Set(eventIds)
  const covered = new Set(clients)
  const next = {
    version: 1,
    pending: (spool.pending ?? []).filter((event) => !sent.has(event.event_id)),
    coverage: (spool.coverage ?? []).filter((row) => !covered.has(row.client)),
  }
  writeJson(spoolPath(), next)
  return next
}

export function skillScanStatus(home = homedir()) {
  const state = readJson(scanStatePath(), defaultState())
  const spool = readSkillScanSpool()
  const sources = discoverSkillLogSources(home)
  return {
    parser_version: SKILL_SCAN_PARSER_VERSION,
    last_scan_at: state.last_scan_at ?? null,
    installs: listSkillInstalls().length,
    pending: spool.pending?.length ?? 0,
    sources: ["claude", "codex"].map((client) => ({
      client,
      files: sources.filter((item) => item.client === client).length,
      tracked: Object.values(state.sources ?? {}).filter((item) => item.client === client).length,
      sessions_90d: Object.keys(state.sessions?.[client] ?? {}).length,
    })),
  }
}

export function groupSkillScanSpool(spool, installs = listSkillInstalls()) {
  const groups = new Map()
  for (const install of installs) {
    const target = {
      server: install.server,
      workspace_id: install.workspace_id ?? null,
      account_id: install.account_id ?? null,
    }
    const key = targetKey(target)
    if (!groups.has(key)) groups.set(key, { target, events: [], coverage: [] })
  }
  for (const event of spool.pending ?? []) {
    const key = targetKey(event.target)
    const group = groups.get(key) ?? { target: event.target, events: [], coverage: [] }
    group.events.push(event)
    groups.set(key, group)
  }
  for (const row of spool.coverage ?? []) {
    // Coverage belongs to every target with an install for this client.
    for (const [key, group] of groups) {
      const hasClient = installs.some((install) => {
        const target = {
          server: install.server,
          workspace_id: install.workspace_id ?? null,
          account_id: install.account_id ?? null,
        }
        return targetKey(target) === key && install.client === row.client
      })
      if (hasClient) group.coverage.push(row)
    }
  }
  return [...groups.values()].filter((group) => group.events.length || group.coverage.length)
}

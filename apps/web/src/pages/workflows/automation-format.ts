import type { AutomationRef, AutomationTrigger } from "@/api"

// Pure formatting for single-Agent workflow definitions and their run history.

export type GithubWorkflowInputs = Record<string, string | number | boolean>

const GITHUB_REPOSITORY_PART = /^[A-Za-z0-9_.-]{1,100}$/
const DERIVE_WORKFLOW_FILE = /^derive-[A-Za-z0-9_.-]{1,193}\.ya?ml$/
const GITHUB_INPUT_NAME = /^[A-Za-z0-9_-]{1,100}$/

/** Parse the one repository shape the API accepts. Returning null keeps the form and its
 *  preview from independently guessing at owner/name boundaries. */
export function githubRepositoryParts(value: string): { owner: string; repo: string } | null {
  const parts = value.trim().split("/")
  const owner = parts[0]
  const repo = parts[1]
  if (
    parts.length !== 2 ||
    !owner ||
    !repo ||
    !GITHUB_REPOSITORY_PART.test(owner) ||
    !GITHUB_REPOSITORY_PART.test(repo)
  )
    return null
  return { owner, repo }
}

export function githubRepositoryError(value: string): string | null {
  if (!value.trim()) return "Enter a repository as owner/name."
  return githubRepositoryParts(value) ? null : "Use owner/name with no spaces or URL."
}

export function githubWorkflowFileError(value: string): string | null {
  const workflow = value.trim()
  if (!workflow) return "Enter the workflow file name."
  return DERIVE_WORKFLOW_FILE.test(workflow)
    ? null
    : "Use a file named derive-*.yml or derive-*.yaml."
}

/** Mirrors the server's git-ref boundary so a person gets the exact refusal before submit. */
export function githubWorkflowRefError(value: string): string | null {
  if (!value || value !== value.trim()) return "Enter a branch, tag, or commit SHA."
  if (value.length > 1_024) return "Git ref must be 1,024 characters or fewer."
  const forbidden = [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x20 || code === 0x7f || "~^:?*[\\".includes(character)
  })
  const invalid =
    value === "@" ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{") ||
    forbidden ||
    value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  return invalid ? "Enter a valid Git branch, tag, or commit SHA." : null
}

export function parseGithubWorkflowInputs(raw: string): {
  value: GithubWorkflowInputs | null
  error: string | null
} {
  let parsed: unknown
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {}
  } catch {
    return { value: null, error: "Inputs must be valid JSON." }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { value: null, error: "Inputs must be a JSON object." }
  const entries = Object.entries(parsed)
  if (entries.length > 25) return { value: null, error: "GitHub accepts at most 25 inputs." }
  for (const [key, input] of entries) {
    if (!GITHUB_INPUT_NAME.test(key))
      return {
        value: null,
        error: "Input names use letters, numbers, underscores, or hyphens (up to 100).",
      }
    if (
      (typeof input !== "string" && typeof input !== "number" && typeof input !== "boolean") ||
      (typeof input === "number" && !Number.isFinite(input))
    )
      return { value: null, error: "Input values must be text, numbers, or booleans." }
  }
  if (JSON.stringify(parsed).length > 65_535)
    return { value: null, error: "Inputs must be 65,535 characters or fewer." }
  return { value: Object.fromEntries(entries) as GithubWorkflowInputs, error: null }
}

export interface GithubActionRunReceipt {
  runId: string
  url: string
  repository: string
  workflow: string
  ref: string
}

/** Read the normalized server receipt, with a compatibility fallback for runs dispatched before
 * it was introduced. The link is reconstructed from validated fields so run metadata cannot
 * inject an arbitrary destination into the UI. */
export function githubActionRunReceipt(meta: string | null): GithubActionRunReceipt | null {
  if (!meta) return null
  try {
    const value = JSON.parse(meta) as Record<string, unknown>
    const action = value.action as Record<string, unknown> | undefined
    const normalized = value.github_action as Record<string, unknown> | undefined
    const response = value.response as Record<string, unknown> | undefined
    const rawId = normalized?.run_id ?? response?.workflow_run_id
    const runId =
      typeof rawId === "number" && Number.isSafeInteger(rawId) && rawId > 0
        ? String(rawId)
        : typeof rawId === "string" && /^[1-9][0-9]{0,19}$/.test(rawId)
          ? rawId
          : null
    const owner = typeof action?.owner === "string" ? action.owner : ""
    const repo = typeof action?.repo === "string" ? action.repo : ""
    const workflow = typeof action?.workflow === "string" ? action.workflow : ""
    const ref = typeof action?.ref === "string" ? action.ref : ""
    if (
      !runId ||
      !githubRepositoryParts(`${owner}/${repo}`) ||
      githubWorkflowFileError(workflow) ||
      githubWorkflowRefError(ref)
    )
      return null
    return {
      runId,
      url: `https://github.com/${owner}/${repo}/actions/runs/${runId}`,
      repository: `${owner}/${repo}`,
      workflow,
      ref,
    }
  } catch {
    return null
  }
}

/** A compact human summary of an automation's targets for the row subtitle, e.g.
 *  "1 artifact, 1 tag" or "2 collections". Empty string when there are no targets. */
export function targetSummary(refs: AutomationRef[]): string {
  const counts = { artifact: 0, collection: 0, tag: 0 }
  for (const r of refs) counts[r.kind] += 1
  const parts: string[] = []
  const add = (n: number, one: string) => n > 0 && parts.push(`${n} ${one}${n === 1 ? "" : "s"}`)
  add(counts.artifact, "artifact")
  add(counts.collection, "collection")
  add(counts.tag, "tag")
  return parts.join(", ")
}

/** One write a run performed, ready for the ledger row: the artifact it touched and the
 *  verb — a run either created it or revised it. */
export interface RunWrite {
  shortId: string
  verb: "created" | "revised"
}

/** Parse meta.writes[] into linked, labelled writes — what the activity row renders. Only
 *  writes that produced an artifact (a short id) are shown; a malformed or writes-less meta
 *  (asks, failed runs) yields []. */
export function runWrites(meta: string | null): RunWrite[] {
  if (!meta) return []
  let raw: unknown
  try {
    raw = JSON.parse(meta)
  } catch {
    return []
  }
  const writes = (raw as { writes?: unknown })?.writes
  if (!Array.isArray(writes)) return []
  const out: RunWrite[] = []
  for (const w of writes as { short_id?: unknown; created?: unknown }[]) {
    if (typeof w?.short_id !== "string" || w.short_id === "") continue
    out.push({ shortId: w.short_id, verb: w.created ? "created" : "revised" })
  }
  return out
}

/** Schedule presets shared by the creation form and trigger labels. */
export const SCHEDULE_PRESETS = [
  { id: "daily", label: "Every day at 9:00 AM", cron: "0 9 * * *" },
  { id: "weekdays", label: "Weekdays at 9:00 AM", cron: "0 9 * * 1-5" },
  { id: "weekly", label: "Mondays at 9:00 AM", cron: "0 9 * * 1" },
] as const

export const EVENT_KINDS = [
  { id: "comment.opened", label: "When someone comments" },
  { id: "upstream.published", label: "When a doc it depends on updates" },
  { id: "webhook", label: "When a webhook fires" },
] as const

const CRON_LABELS: Record<string, string> = Object.fromEntries(
  SCHEDULE_PRESETS.map((p) => [p.cron, p.label]),
)
const EVENT_LABELS: Record<string, string> = Object.fromEntries(
  EVENT_KINDS.map((e) => [e.id, e.label]),
)

/** A human label for an automation's trigger — the row subtitle + the pill. */
export function triggerLabel(t: AutomationTrigger): string {
  if (t.kind === "schedule")
    return t.cron ? (CRON_LABELS[t.cron] ?? `Schedule · ${t.cron}`) : "Schedule"
  if (t.kind === "event") return t.on ? (EVENT_LABELS[t.on] ?? `On ${t.on}`) : "On an event"
  return "Run on demand"
}

/** The semantic outcome (published/answered/…) recorded in a run's meta blob, or null. */
export function runOutcome(meta: string | null): string | null {
  if (!meta) return null
  try {
    const m = JSON.parse(meta) as { outcome?: unknown }
    return typeof m.outcome === "string" ? m.outcome : null
  } catch {
    return null
  }
}

export const runOutcomeLabel = (outcome: string): string =>
  outcome.charAt(0).toUpperCase() + outcome.slice(1).replaceAll("_", " ")

export interface RunExecutionReceipt {
  provider: "claude-code" | "codex"
  location: "hosted" | "local"
  model: string | null
  actions: number
  threadId: string | null
}

/** The execution proof attached at enqueue (provider/location/model) and enriched at finish with
 *  the coding agent's structured action count + thread id. Malformed or historical rows are
 *  simply quiet in the activity list. */
export function runExecutionReceipt(meta: string | null): RunExecutionReceipt | null {
  if (!meta) return null
  try {
    const value = JSON.parse(meta) as Record<string, unknown>
    const execution = value.execution as Record<string, unknown> | undefined
    if (!execution || (execution.provider !== "claude-code" && execution.provider !== "codex"))
      return null
    return {
      provider: execution.provider,
      location: execution.location === "local" ? "local" : "hosted",
      model: typeof execution.model === "string" ? execution.model : null,
      actions: Array.isArray(value.actions) ? value.actions.length : 0,
      threadId: typeof value.thread_id === "string" ? value.thread_id : null,
    }
  } catch {
    return null
  }
}

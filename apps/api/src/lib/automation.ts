import {
  type AutomationRecord,
  type AutomationTrigger,
  DEFAULT_EXECUTION_PROVIDER,
  type ExecutionProvider,
  normalizeSelectors,
  parseRunExecution,
  parseRunMeta,
  type RunExecution,
  type Selector,
} from "@derive/core"

// Shared parsing for an automation's serialized JSON blobs. Both blobs parse DEFENSIVELY — a
// single malformed row must never 500 a list / claim path — so every reader (the routes and the
// executor surface) goes through here rather than re-rolling it.

/** Parse a stored AutomationTrigger, defaulting to a manual trigger on malformed JSON. */
export const parseTrigger = (raw: string): AutomationTrigger => {
  try {
    const t = JSON.parse(raw)
    if (t && typeof t === "object") return t as AutomationTrigger
  } catch {}
  return { kind: "manual" }
}

/** Stored refs → canonical selectors. Rows predating selectors hold bare short-id strings;
 *  normalizeSelectors turns those into artifact selectors, so every historical row stays valid
 *  with no migration. Malformed JSON parses to []. */
export const parseRefs = (raw: string | null): Selector[] => {
  try {
    if (raw) return normalizeSelectors(JSON.parse(raw))
  } catch {}
  return []
}

/** Historical rows predate the provider column and are Claude by definition. */
export const automationProvider = (a: Pick<AutomationRecord, "provider">): ExecutionProvider =>
  a.provider ?? DEFAULT_EXECUTION_PROVIDER

/** Snapshot the material execution choice at enqueue time. */
export const executionForAutomation = (a: Pick<AutomationRecord, "provider">): RunExecution => ({
  version: 1,
  provider: automationProvider(a),
  location: "hosted",
  model: null,
})

/** Merge caller-owned run metadata with the immutable execution snapshot. */
export const runMetaForAutomation = (
  a: Pick<AutomationRecord, "provider">,
  fields: Record<string, unknown> = {},
): string => JSON.stringify({ ...fields, execution: executionForAutomation(a) })

/** Read the snapshot first; only historical queued rows fall back to the current definition. */
export const executionForRun = (
  meta: string | null | undefined,
  a: Pick<AutomationRecord, "provider">,
): RunExecution => parseRunExecution(parseRunMeta(meta), automationProvider(a))

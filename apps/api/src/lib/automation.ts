import { type AutomationTrigger, normalizeSelectors, type Selector } from "@derive/core"

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

/** An automation's bound connection ids (a JSON string array), parsed defensively → []. */
export const parseConnectionIds = (raw: string | null): string[] => {
  if (!raw) return []
  try {
    const a = JSON.parse(raw)
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

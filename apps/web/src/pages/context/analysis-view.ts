import type { ContextAnalysis } from "@/api"

type Analysis = NonNullable<ContextAnalysis["analysis"]>
export type AnalysisStatus = Analysis["contributions"][number]["details"][number]["status"]

/** How often the page looks for the analysis a copied prompt asked an agent for. */
export const ANALYSIS_POLL_MS = 5_000
/** And for how long: reading a paper and its code takes an agent minutes, not hours. */
export const ANALYSIS_WAIT_MS = 15 * 60_000

/** A prompt was copied at `since`, when the analysis stood at `version` (null: none yet). */
export interface AnalysisWait {
  since: number
  version: number | null
}

/** Whether to keep looking for the analysis a copied prompt asked for: until one appears or its
 *  version moves, and never past ANALYSIS_WAIT_MS. False stops polling. */
export const analysisPollInterval = (
  wait: AnalysisWait | null,
  version: number | null,
  now: number,
): number | false =>
  wait && now - wait.since <= ANALYSIS_WAIT_MS && version === wait.version
    ? ANALYSIS_POLL_MS
    : false

export const ANALYSIS_STATUS_ORDER: readonly AnalysisStatus[] = [
  "implemented",
  "partial",
  "differs",
  "not_found",
]

export const ANALYSIS_STATUS_LABEL: Record<AnalysisStatus, string> = {
  implemented: "Implemented",
  partial: "Partly implemented",
  differs: "Differs from the paper",
  not_found: "Not found in the code",
}

export const ANALYSIS_STATUS_BADGE: Record<
  AnalysisStatus,
  "success" | "warning" | "destructive" | "outline"
> = {
  implemented: "success",
  partial: "warning",
  differs: "destructive",
  not_found: "outline",
}

/** A code reference the way a person scans it: the path, then the symbol and lines. */
export const codeRefLabel = (ref: {
  path: string
  symbol: string | null
  lines: string | null
}): string =>
  [ref.path, ref.symbol, ref.lines ? `lines ${ref.lines}` : null].filter(Boolean).join(" · ")

/** The heading a paper reference names (`main.tex#method` names `method`), which opens the paper
 *  at that heading; null for a reference to a whole page. */
export const sectionSlugOf = (section: string): string | null => {
  const hash = section.lastIndexOf("#")
  return hash > 0 && hash < section.length - 1 ? section.slice(hash + 1) : null
}

/** A paper reference the way a person scans it: the heading it names when known, else the page
 *  and section, then the label. */
export const paperRefLabel = (ref: {
  section: string
  heading: string | null
  label: string | null
}): string => [ref.heading ?? ref.section, ref.label].filter(Boolean).join(" · ")

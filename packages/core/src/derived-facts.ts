/**
 * Derived facts: the host's mechanical reading of a version's bytes, served through the
 * same surfaces as authored facts under the `$` namespace (@derive/facts declares it; the
 * name grammar makes it unreachable to authors).
 *
 * The one line every deriver must hold: TRANSCRIPTION, NEVER INTERPRETATION. Counting
 * words is derivation; deciding what a number means is testimony only an author can give
 * (that path is the proposal channel, not this file). Nothing here may guess.
 *
 * Derivers live HERE and not in @derive/facts deliberately: $outline needs sectionMarkers,
 * and the facts package is dependency-free by contract (lint-enforced) because it is the
 * piece other hosts reimplement. The portable convention is the NAMESPACE; every host owns
 * its own derivers.
 *
 * All of this is recomputable by definition, which is what makes it safe: a derived row is
 * a cache entry with a name, not a record. Deleting every `$` row loses nothing.
 */

import { isDerivedFactName, MAX_FACT_BYTES } from "@derive/facts"
import { pageText } from "./anchor"
import { type SectionMarker, sectionMarkers } from "./doc-text"
import { parseRef } from "./ids"

/** Sentinel for a `$name` no deriver owns — a typo, or a deriver since removed. It matches
 *  no stored gen, so the read path re-derives once; that write is prefix-scoped and
 *  replaces every `$` row, which garbage-collects the dead one. A retired deriver's output
 *  must stop being served, and 1 (the column default) would serve it forever. */
const UNKNOWN_DERIVED_GEN = 0

/** The generation of ONE deriver's output, from the table below where it sits beside the
 *  function it governs. PER DERIVER, never per host: one shared constant means a cosmetic
 *  change to $stats marks every $links row in the corpus stale, and a consumer that cannot
 *  re-derive on the fly (a corpus scan is bounded away from compute) then has to choose
 *  between serving stale output and serving none. Same discipline as FACT_GEN (extraction
 *  grammar) and #433's dv1 (derived views), for the same reason: a stored row must say
 *  which code produced it, so stale rows re-derive lazily instead of serving an old
 *  algorithm's output forever. */
export const derivedGen = (slot: string): number =>
  DERIVERS.find((d) => d.slot === slot)?.gen ?? UNKNOWN_DERIVED_GEN

/** Ceiling on outline entries: keeps the JSON far under MAX_FACT_BYTES for any real
 *  document while still covering a 200-section monster. Past it the row says so. */
const OUTLINE_MAX_SECTIONS = 200

export interface DerivedFact {
  slot: string
  json: string
  bytes: number
  /** The generation of the deriver that produced THIS row, carried so every writer stamps
   *  the row's own generation rather than reaching for a host-wide constant. */
  gen: number
}

const byteLength = (s: string): number => new TextEncoder().encode(s).length

/** The section spine — heading/landmark labels with 1-based source lines, exactly what
 *  `read`'s outline view walks. Null when the document has fewer than two sections:
 *  a one-heading page has no navigable structure worth a row. */
const deriveOutline = (markers: SectionMarker[]): unknown => {
  if (markers.length < 2) return null
  const sections = markers
    .slice(0, OUTLINE_MAX_SECTIONS)
    .map((m) => ({ label: m.text, line: m.line }))
  return markers.length > OUTLINE_MAX_SECTIONS
    ? { sections, truncated: true, total: markers.length }
    : { sections }
}

// Linear-time by construction (the CodeQL round's lesson): [^"']*, [^\s>]+ and [^)\s]*
// cannot overlap their delimiters, so there is no ambiguity to backtrack over.
//
// The unquoted third alternative is legal HTML (href=/artifacts/x-abc12345) and was
// MISSED until a dogfood run against the real library published one and watched the edge
// vanish. A missing edge is the worse failure here: a false edge is visible and arguable,
// an absent one silently understates the graph. Same shape doc-text.ts's attrOf uses.
const HTML_HREF = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi
const MD_LINK = /\]\(([^)\s]+)\)/g

/** Outbound references to OTHER artifacts: short ids resolved from href values or markdown
 *  link targets — `/artifacts/<ref>` paths and derive.to absolute forms. LINK TARGETS only,
 *  deliberately: a short id mentioned in prose is a string, not an edge. Null when the
 *  document references nothing. Transcription caveat, stated where it matters: this records
 *  that a reference EXISTS, never why — footer boilerplate and a load-bearing citation look
 *  identical here, and weighting them is the consumer's job.
 *
 *  BOTH forms are scanned in BOTH content types (gen 2). Picking one by content type lost
 *  every raw `<a href>` in a markdown doc and every `](/artifacts/…)` in an HTML page, which
 *  are common enough in real documents to leave holes in the graph the index is built from.
 *  There is no false-positive shape in the crossover: a markdown link inside HTML is still a
 *  reference, and so is an anchor inside markdown. Same reasoning as the unquoted-href fix —
 *  a false edge is visible and arguable, an absent one silently understates the graph. */
const deriveLinks = (source: string): unknown => {
  const targets: string[] = []
  for (const m of source.matchAll(HTML_HREF)) targets.push(m[2] ?? m[3] ?? m[4] ?? "")
  for (const m of source.matchAll(MD_LINK)) targets.push(m[1] ?? "")
  const refs: string[] = []
  for (const t of targets) {
    const m = /\/artifacts\/([^/?#\s]+)/.exec(t)
    if (!m?.[1]) continue
    // Guarded PER TARGET: decodeURIComponent throws on malformed percent-encoding, and
    // one bad href in someone's page must cost that edge, never the whole row.
    let ref = m[1]
    try {
      ref = decodeURIComponent(ref)
    } catch {
      /* use the raw segment */
    }
    const { shortId } = parseRef(ref)
    if (/^[0-9a-z]{6,12}$/.test(shortId) && !refs.includes(shortId)) refs.push(shortId)
  }
  return refs.length ? { refs } : null
}

/** Counting, never judging — and nothing with an embedded assumption (no reading-time:
 *  a words-per-minute constant is a judgment wearing a number). `words` counts the
 *  VISIBLE text for HTML, so markup weight doesn't masquerade as prose. */
const deriveStats = (source: string, contentType: string, markers: SectionMarker[]): unknown => {
  const isHtml = contentType.includes("html")
  const visible = isHtml ? pageText(source) : source
  const words = visible.split(/\s+/).filter(Boolean).length
  const sections = markers.length
  const codeBlocks = isHtml
    ? (source.match(/<pre\b/gi) ?? []).length
    : (source.match(/^[ \t]*```/gm) ?? []).length >> 1
  const tables = isHtml
    ? (source.match(/<table\b/gi) ?? []).length
    : (source.match(/^\s*\|[\s:|-]+\|\s*$/gm) ?? []).length
  return { chars: source.length, words, sections, code_blocks: codeBlocks, tables }
}

// Section markers are computed ONCE and shared: two derivers need them, and this runs on
// the hot path of every html/markdown publish.
//
// `gen` lives HERE, in the same line as the function it governs, so bumping it is part of
// changing the deriver rather than a second edit somewhere else that has to be remembered.
const DERIVERS: {
  slot: string
  gen: number
  derive: (source: string, contentType: string, markers: SectionMarker[]) => unknown
}[] = [
  { slot: "$outline", gen: 1, derive: (_s, _ct, markers) => deriveOutline(markers) },
  { slot: "$links", gen: 2, derive: (source) => deriveLinks(source) },
  { slot: "$stats", gen: 1, derive: deriveStats },
]

/**
 * Every derived fact for one version's source. Pure, no I/O, linear-time; a deriver
 * returning null emits no row (absence is absence — §3.2 applies to the host's own
 * output too). A payload past MAX_FACT_BYTES is dropped rather than truncated blind:
 * the only deriver that can plausibly grow ($outline) bounds itself above, and a
 * silent partial JSON row would be worse than an absent one.
 */
/**
 * The author-reward filter, shared so it cannot be hand-rolled divergently.
 *
 * Four surfaces exist to pay authors for asserting — the two publish receipts (MCP
 * and REST), the share card, the review deltas — and every one must show ASSERTED facts only. A card leading
 * with $stats word-counts instead of the author's numbers, or a receipt in which the host
 * congratulates itself, destroys the exact incentive the reward surfaces shipped to
 * create. One helper, every call site, and the lint that checks those sites checks for
 * THIS name — a divergent inline filter is indistinguishable from a missing one.
 */
export const assertedOnly = <T extends { slot: string }>(rows: T[]): T[] =>
  rows.filter((r) => !isDerivedFactName(r.slot))

export const deriveFacts = (source: string, contentType: string): DerivedFact[] => {
  const out: DerivedFact[] = []
  const markers = sectionMarkers(source, contentType)
  for (const { slot, gen, derive } of DERIVERS) {
    if (!isDerivedFactName(slot)) continue // structurally impossible; keeps the invariant loud
    let value: unknown
    try {
      value = derive(source, contentType, markers)
    } catch {
      continue // a deriver must never fail a publish; a missing row is a cache miss
    }
    if (value == null) continue
    const json = JSON.stringify(value)
    const bytes = byteLength(json)
    if (bytes > MAX_FACT_BYTES) continue
    out.push({ slot, json, bytes, gen })
  }
  return out
}

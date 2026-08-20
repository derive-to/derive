/**
 * Structured facts. An artifact is a document that an agent authored; a fact lets
 * that same document carry a small, named JSON payload the agent can query back across
 * versions without re-parsing its own old markup. The data lives INSIDE the source — an
 * inert `<script type="application/derive-data" data-slot="…">` in HTML, or a
 * ```` ```derive-data <slot> ```` fence in markdown — so it travels through every publish
 * path (inline, staged doc, REST, CLI, the editor) for free and can never drift from the
 * page, because it IS the page. Extraction is pure and must run on Cloudflare Workers, so
 * this is a tokenizer with no DOM and no dependencies, in the style of doc-text.ts.
 *
 * Nothing here throws: a malformed block yields an advisory and is skipped, never a failed
 * publish. The same parser feeds two callers — the publish response's advisories (so the
 * author is told at the moment of the mistake) and the version-bump persistence (so the
 * stored rows and the advice can never disagree).
 */

/** Bump when the grammar or extraction semantics change, so a stored row's `gen` marks
 *  which rules produced it and an older version can be re-extracted lazily on read — the
 *  same generation lever the derived-view cache uses. */
export const FACT_GEN = 1

/** Per-slot ceiling on the stored JSON text. Past it the fact is skipped with an advisory. */
export const MAX_FACT_BYTES = 32 * 1024
/** Per-version ceiling on the number of facts. Extras are dropped with an advisory. */
export const MAX_FACTS_PER_VERSION = 20

/** Ceiling on the raw (slot, artifact) rows the fact CATALOG pulls before the caller
 *  narrows them to what it may see. The catalog cannot be counted in SQL (that would count
 *  artifacts the caller has no read on), so the rows travel to the caller and the cap is
 *  what keeps that bounded. At 20 facts per version this covers a workspace of ~250
 *  fact-bearing artifacts, well past any real one; a workspace that exceeds it gets a
 *  vocabulary drawn from a subset, which is a listing, not a wrong answer. */
export const WORKSPACE_FACT_ROW_CAP = 5000

/** Fact names are url-safe and short: they appear in `read(data:"…")` and a raw route. */
const SLOT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * The DERIVED-fact namespace: names the host computes, never the author.
 *
 * An asserted fact is testimony — the author's claim, extracted from a block they
 * published, canonical forever. A derived fact is verification — the host's mechanical
 * reading of the same bytes ($outline, $links, $stats), regenerable at will and deletable
 * without loss because the source IS the document.
 *
 * The "$" prefix is not a convention to remember; it is OUTSIDE the authored grammar.
 * SLOT_NAME_RE above rejects "$", so a block claiming data-fact="$outline" already fails
 * validation with the invalid-name advisory. No author can collide with the host, no host
 * output can impersonate an author, and nothing new needs enforcing.
 *
 * The namespace lives HERE, in the portable package, because it is part of the convention
 * an independent host must honor (never counting derived names as adoption, never letting
 * them into author-reward surfaces). The derivers themselves are deliberately NOT here:
 * each host owns its derivers, and this package stays dependency-free.
 */
export const DERIVED_FACT_PREFIX = "$"
export const isDerivedFactName = (name: string): boolean => name.startsWith(DERIVED_FACT_PREFIX)

/** The script type that marks an HTML fact block. Inert in every browser. */
export const FACT_SCRIPT_TYPE = "application/derive-facts"
/** The markdown fence info word that marks a fact block. */
export const FACT_FENCE_LANG = "derive-facts"
/** The attribute naming a fact. */
export const FACT_NAME_ATTR = "data-fact"

/**
 * The original spellings, accepted FOREVER.
 *
 * This shipped as "facts" before the name settled, and a version is IMMUTABLE: documents
 * already published carry the old spelling in bytes nothing may rewrite, so they have to
 * keep parsing identically a decade from now. Accepting both costs an array membership
 * test. Refusing the old one would silently empty the history of anything published early
 * — the same class of harm §3.2 forbids when it bans fabricated gaps, arriving from the
 * other direction.
 *
 * New writers meet only the new spelling, in the skill and the docs. Nothing rewrites old
 * bytes, and nothing ever should.
 */
const LEGACY_SCRIPT_TYPES = ["application/derive-data"]
const LEGACY_FENCE_LANGS = ["derive-data"]

/** HTML-shaped source types understood by this dependency-free parser. Keep the richer Derive
 * subtype explicit here; importing @derive/core would invert the package dependency. */
const isHtmlSourceType = (contentType: string): boolean => {
  const ct = contentType.toLowerCase()
  return ct.includes("html") || ct === "text/x-derive-linked-bundle"
}
const NAME_ATTRS = [FACT_NAME_ATTR, "data-slot"]

const isFactScriptType = (t: string): boolean =>
  t === FACT_SCRIPT_TYPE || LEGACY_SCRIPT_TYPES.includes(t)
const isFactFenceLang = (t: string): boolean =>
  t === FACT_FENCE_LANG || LEGACY_FENCE_LANGS.includes(t)

/** One extracted, validated slot: the trimmed source text of the block and its byte size. */
export interface ParsedFact {
  slot: string
  json: string
  bytes: number
}

export interface FactsResult {
  /** Facts that parsed, in document order, first-occurrence-wins, capped. */
  facts: ParsedFact[]
  /** Human-readable notes about what was skipped and why (empty when all clean). */
  advisories: string[]
}

const byteLength = (s: string): number => new TextEncoder().encode(s).length

/**
 * Does this text end inside an unterminated JSON string? An odd number of unescaped
 * double quotes means the block was cut mid-string — which, for an HTML data block, is
 * almost always a literal `</script>` in the JSON: the HTML parser ends the script there
 * no matter what a JSON string wanted, exactly as a browser does. Worth detecting because
 * the raw "not valid JSON" verdict is actively misleading in that case — the author is
 * looking at JSON that IS valid, and nothing points at the real cause or the fix.
 */
const endsInsideString = (s: string): boolean => {
  let quotes = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '"') continue
    let backslashes = 0
    for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) backslashes++
    if (backslashes % 2 === 0) quotes++
  }
  return quotes % 2 === 1
}

/** Read one double- or single-quoted attribute value out of a raw tag's attribute text. */
const attr = (attrs: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(attrs)
  return m ? (m[2] ?? m[3] ?? "") : null
}

// A <script …>…</script> block, ended the way a BROWSER ends it: the close tag may carry
// whitespace or junk before its ">" ("</script >", "</script foo>") and still terminates
// the element. Matching only the literal "</script>" here made the parser read PAST a
// close tag the browser honored, so the two disagreed about where the body ends — the
// exact drift SPEC.md's normative close-tag hazard exists to prevent, present in the
// reference implementation itself until CodeQL flagged it.
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi

interface RawBlock {
  slot: string
  body: string
  /** Written with the pre-rename spelling. Parsed identically; recorded only so the
   *  publish response can OFFER the current one. Never a reason to store less. */
  legacy?: boolean
}

const htmlBlocks = (source: string): RawBlock[] => {
  const out: RawBlock[] = []
  SCRIPT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  m = SCRIPT_RE.exec(source)
  while (m) {
    const attrs = m[1] ?? ""
    // TRIMMED, like a browser reads a type attribute: `type="application/derive-facts "`
    // is the same script to the HTML parser, and without the trim it was silently not a
    // fact block at all — no fact, no advisory, nothing to notice.
    const type = attr(attrs, "type")?.trim()
    if (type && isFactScriptType(type.toLowerCase())) {
      // Either spelling of the name attribute; the first one present wins.
      let name: string | null = null
      let usedLegacyAttr = false
      for (const a of NAME_ATTRS) {
        const v = attr(attrs, a)?.trim()
        if (v != null) {
          name = v
          usedLegacyAttr = a !== FACT_NAME_ATTR
          break
        }
      }
      const legacy = usedLegacyAttr || type.toLowerCase() !== FACT_SCRIPT_TYPE
      // A fact-typed script with no name attribute is a usage error worth naming, but with
      // no name there's nothing to key it on — surface it as a synthetic empty name so the
      // validation pass below advises about it uniformly.
      out.push({ slot: name ?? "", body: m[2] ?? "", legacy })
    }
    m = SCRIPT_RE.exec(source)
  }
  return out
}

// The fence opener and closer, each anchored to ONE line. The old single mega-regex
// spanned the whole block with a lazy [\s\S]*? and ambiguous whitespace runs, which
// CodeQL correctly called polynomial on adversarial input — a parser meant to run on
// untrusted documents on any host cannot carry a ReDoS. A line scanner is linear by
// construction and matches the documented grammar more literally than the regex did.
// Captures the info word so BOTH spellings parse (see LEGACY_FENCE_LANGS); a fence whose
// word is anything else is somebody's ordinary code block and is left alone.
const FENCE_OPEN = /^[ \t]*```[ \t]*([a-z-]+)[ \t]+([^\s`]+)[ \t]*$/
const FENCE_CLOSE = /^[ \t]*```[ \t]*$/

const markdownBlocks = (source: string): RawBlock[] => {
  const out: RawBlock[] = []
  const lines = source.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec((lines[i] as string).replace(/\r$/, ""))
    if (!open || !isFactFenceLang(open[1] ?? "")) continue
    const body: string[] = []
    let closed = false
    for (let j = i + 1; j < lines.length; j++) {
      const line = (lines[j] as string).replace(/\r$/, "")
      if (FENCE_CLOSE.test(line)) {
        out.push({
          slot: open[2] ?? "",
          body: body.join("\n"),
          legacy: (open[1] ?? "") !== FACT_FENCE_LANG,
        })
        i = j // resume after the closer
        closed = true
        break
      }
      body.push(line)
    }
    // An unclosed fence matches the old behavior: no block, and the JSON-validation
    // pass never sees it (markdown has no </script> analog to advise about).
    if (!closed) break
  }
  return out
}

/**
 * Extract every facts from a single-file source. `contentType` selects the grammar
 * (text/html → script blocks; text/markdown → fences); any other type has no facts. First
 * occurrence of a name wins; a later duplicate, an invalid name, invalid JSON, an oversize
 * body, or a fact past the per-version cap each yields an advisory and is skipped. Pure and
 * total — safe to call twice (once to advise, once to persist) with identical results.
 */
/**
 * A fact's SHAPE: its sorted key paths with value kinds, e.g. `fail:number|pass:number`.
 * Two versions with the same shape are comparable; two with different shapes are not,
 * however similar they look.
 *
 * This exists because of the quiet way a trend read goes wrong. Nothing rejects a fact
 * whose keys drift — rename `pass` to `passed` at v20 and `versions:"all"` still returns
 * thirty happy-looking points that are silently two different metrics, with the break
 * invisible unless you read every one. A series that gets LESS trustworthy the longer it
 * runs is worse than no series, so the drift gets named at the moment it happens.
 *
 * Depth-limited and count-capped: a fingerprint is for comparison, not for describing an
 * arbitrarily deep document, and this runs on the publish path.
 */
export const factShape = (value: unknown, depth = 0, prefix = ""): string => {
  const kind = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v)
  if (depth >= 3 || value === null || typeof value !== "object" || Array.isArray(value))
    return `${prefix}:${kind(value)}`
  const keys = Object.keys(value as Record<string, unknown>)
    .sort()
    .slice(0, 40)
  if (!keys.length) return `${prefix}:object`
  return keys
    .map((k) =>
      factShape((value as Record<string, unknown>)[k], depth + 1, prefix ? `${prefix}.${k}` : k),
    )
    .join("|")
}

/** The shape of a stored slot's JSON, or null when it can't be parsed. */
export const shapeOfJson = (json: string): string | null => {
  try {
    return factShape(JSON.parse(json))
  } catch {
    return null
  }
}

/**
 * Compare a version's slot shapes against the previous version's and describe any drift.
 * Empty when nothing changed, when a fact is new, or when a fact simply went away (both
 * are ordinary authoring, not a broken series). Pure: the caller supplies the previous
 * shapes, so this stays testable and Workers-safe.
 */
export const factDriftAdvisories = (
  current: { slot: string; json: string }[],
  previous: { slot: string; shape: string | null }[],
): string[] => {
  const before = new Map(previous.map((p) => [p.slot, p.shape]))
  const out: string[] = []
  for (const s of current) {
    const was = before.get(s.slot)
    if (was === undefined || was === null) continue // new slot, or an unparseable old row
    const now = shapeOfJson(s.json)
    if (!now || now === was) continue
    const wasKeys = new Set(was.split("|"))
    const nowKeys = new Set(now.split("|"))
    const gone = [...wasKeys].filter((k) => !nowKeys.has(k))
    const added = [...nowKeys].filter((k) => !wasKeys.has(k))
    out.push(
      `Facts "${s.slot}" changed shape from the previous version` +
        (gone.length ? ` (gone: ${gone.slice(0, 6).join(", ")})` : "") +
        (added.length ? ` (new: ${added.slice(0, 6).join(", ")})` : "") +
        `. Reading this slot across versions now mixes two shapes, and nothing else will ` +
        `tell you — if this was a rename, past versions still carry the old keys.`,
    )
  }
  return out
}

/** At most this many fields appear in an unfurl summary — a share card has room for a
 *  glance, not a dump, and the leading keys are almost always the headline ones. */
const SUMMARY_MAX_FIELDS = 3
/** Longest a single summarized value may be before it is dropped as unfit for a card. */
const SUMMARY_MAX_VALUE = 16

/**
 * A one-line, card-sized summary of a version's facts: `pass 48 · fail 0 · flaky 1`.
 *
 * This is the incentive half of facts, and the cheapest one available. The prior art
 * is unambiguous that embedded-data conventions live or die on whether publishing is
 * REWARDED at the moment of publishing: OpenGraph became near-universal because Facebook
 * rendered a prettier card the instant you added four meta tags, while better-specified
 * conventions with no rewarding consumer died unadopted. A fact that makes your shared
 * link show its own numbers is that mechanic, applied to agent-emitted data.
 *
 * Deliberately shallow and lossy: scalars only (a nested object on a share card is noise),
 * the first few fields, short values, numbers formatted plainly. Returns null when there
 * is nothing card-worthy, so the caller falls back to the ordinary description rather than
 * rendering an empty flourish.
 */
export const factSummary = (rows: { slot: string; json: string }[]): string | null => {
  const parts: string[] = []
  for (const row of rows) {
    let value: unknown
    try {
      value = JSON.parse(row.json)
    } catch {
      continue
    }
    // A bare scalar slot summarizes as `slotname value`; an object contributes its own
    // leading scalar fields, which is the shape a metrics slot actually takes.
    const fields: [string, unknown][] =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.entries(value as Record<string, unknown>)
        : [[row.slot, value]]
    for (const [k, v] of fields) {
      if (parts.length >= SUMMARY_MAX_FIELDS) break
      if (v === null || typeof v === "object") continue
      const text =
        typeof v === "number" ? String(Number.isInteger(v) ? v : Number(v.toFixed(2))) : String(v)
      if (!text || text.length > SUMMARY_MAX_VALUE) continue
      parts.push(`${k} ${text}`)
    }
    if (parts.length >= SUMMARY_MAX_FIELDS) break
  }
  return parts.length ? parts.join(" · ") : null
}

/** Most deltas reported between two versions; past this the list stops being readable
 *  and the reader should look at the data itself. */
const MAX_DELTAS = 8

/** Flatten a fact's scalar leaves to `key -> text`, so two versions can be compared
 *  field by field without walking structure twice. Depth-limited like factShape. */
const scalarLeaves = (value: unknown, depth = 0, prefix = ""): Map<string, string> => {
  const out = new Map<string, string>()
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    if (prefix) out.set(prefix, Array.isArray(value) ? JSON.stringify(value) : String(value))
    return out
  }
  if (depth >= 3) return out
  for (const [k, v] of Object.entries(value as Record<string, unknown>))
    for (const [kk, vv] of scalarLeaves(v, depth + 1, prefix ? `${prefix}.${k}` : k))
      out.set(kk, vv)
  return out
}

/**
 * What changed between two versions' facts, as readable lines: `checks.pass 41 → 44`.
 *
 * The review loop is where humans already are, so this is the cheapest way to put the
 * numbers in front of them: a version diff that shows prose changes but not the figures
 * the page is actually about is only half a diff. Scalar leaves only, capped, and it
 * reports a fact appearing or disappearing as its own line since that is usually the more
 * important event.
 */
export const factDeltas = (
  before: { slot: string; json: string }[],
  after: { slot: string; json: string }[],
): string[] => {
  const parse = (rows: { slot: string; json: string }[]) => {
    const m = new Map<string, Map<string, string>>()
    for (const r of rows) {
      try {
        m.set(r.slot, scalarLeaves(JSON.parse(r.json), 0, ""))
      } catch {
        // An unparseable stored row simply has nothing to compare.
      }
    }
    return m
  }
  const a = parse(before)
  const b = parse(after)
  const out: string[] = []
  for (const [slot, now] of b) {
    if (!a.has(slot)) {
      out.push(`${slot} (new)`)
      continue
    }
    const was = a.get(slot) as Map<string, string>
    for (const [key, v] of now) {
      if (out.length >= MAX_DELTAS) return out
      const prev = was.get(key)
      if (prev === undefined) out.push(`${slot}.${key} ${v} (new)`)
      else if (prev !== v) out.push(`${slot}.${key} ${prev} → ${v}`)
    }
  }
  for (const slot of a.keys())
    if (!b.has(slot) && out.length < MAX_DELTAS) out.push(`${slot} (gone)`)
  return out
}

/** How many numeric table cells make a page "carrying data" rather than "mentioning a
 *  number". Deliberately conservative: a missed nudge costs nothing, a false one trains
 *  the reader to skip advisories, and that channel is load-bearing everywhere else. */
const DATA_TABLE_MIN_CELLS = 4

// A numeric cell: an HTML <td> or a markdown table cell whose whole content is a number
// (with optional %, $, commas, decimals, sign). Prose containing a figure never matches,
// because the CELL has to be the number.
// Cell detection in two LINEAR steps: grab short cell bodies with an unambiguous
// character class ([^<] / [^|\n] cannot overlap the delimiters), then validate each
// bounded capture with an anchored check. The old single-regex forms interleaved \s*
// runs around optional characters, which is the classic polynomial-backtracking shape
// CodeQL flagged — and an advisory helper must never be the slow path of a publish.
// The attribute run is BOUNDED, and that bound is what makes this linear. Unbounded, `[^>]*`
// scans to end-of-string from every `<td` before failing to find a `>` — so a page of
// `<td<td<td…` (no `>` anywhere, the exact CodeQL shape) costs one full scan per start
// position: O(n²), measured at 4s for 40k repetitions. 200 characters is far more than any
// real cell's attributes, and the only thing over-long attributes cost is being left out of an
// advisory's cell count — a heuristic nudge, not a correctness claim.
const HTML_CELL = /<td\b[^>]{0,200}>([^<]{1,40})<\/td>/gi
const MD_TABLE_ROW = /^\s*\|.+\|\s*$/gm
const MD_CELL = /\|([^|\n]{1,40})(?=\|)/g
// Validated on a TRIMMED capture so the pattern carries no whitespace at all — the first
// version kept \s* runs around the optional % and was itself flagged as polynomial. The
// second lesson of the round: the fix for an ambiguous regex is not a subtler regex.
const NUMERIC_CELL = /^[-+$]?\d[\d,]*(?:\.\d+)?%?$/
const isNumericCell = (s: string): boolean => NUMERIC_CELL.test(s.trim())

/**
 * Does this page carry FIGURES that no slot makes queryable? The nudge that turns facts
 * from a thing you must remember into a thing you get told about at the moment you would
 * have wanted it — the same move as every other advisory here, and the reason those exist:
 * correct-by-construction beats correct-by-vigilance.
 *
 * Written after watching an agent (me) build facts and then publish fifteen versions of
 * pages full of numbers without emitting a single one. The gap was never knowing how; it
 * was that nothing asked at the moment of publishing.
 *
 * Returns null when the page already carries a fact, when it has no tabular figures, or
 * when the content type has no slot grammar at all.
 */
export const missingFactAdvisory = (source: string, contentType: string): string | null => {
  const ct = contentType.toLowerCase()
  const isHtml = isHtmlSourceType(ct)
  if (!isHtml && !ct.includes("markdown")) return null
  // Already carries data (or tried to — a malformed block gets its own advisory).
  if (parseFacts(source, contentType).facts.length > 0) return null
  // BOTH spellings count as "already tried". Matching only the current one would nag an
  // author to add a fact their page already carries, because their block was written
  // before the rename and merely failed to parse — the most irritating possible advice.
  if (/derive-facts|derive-data/.test(source)) return null

  let cells = 0
  if (isHtml) {
    for (const m of source.matchAll(HTML_CELL)) if (isNumericCell(m[1] ?? "")) cells++
  } else {
    for (const row of source.match(MD_TABLE_ROW) ?? [])
      for (const m of row.matchAll(MD_CELL)) if (isNumericCell(m[1] ?? "")) cells++
  }
  if (cells < DATA_TABLE_MIN_CELLS) return null

  return (
    `This page carries ${cells} numeric table cells but no facts, so those figures are ` +
    `readable only by parsing this markup — including by you, later, on every past version. ` +
    `A \`derive-data\` block (see the publishing skill) stores them per version, so ` +
    `read(data:"<name>", versions:"all") answers "how did this change over time" in one call. ` +
    `Ignorable: plenty of pages are prose that happens to contain a table.`
  )
}

export const parseFacts = (source: string, contentType: string): FactsResult => {
  const ct = contentType.toLowerCase()
  const raw = isHtmlSourceType(ct)
    ? htmlBlocks(source)
    : ct.includes("markdown")
      ? markdownBlocks(source)
      : []

  const facts: ParsedFact[] = []
  const advisories: string[] = []
  const seen = new Set<string>()

  // Self-heal by INVITATION, once per publish rather than once per block.
  //
  // The old spelling parses forever, so nothing is broken and nothing is withheld. What
  // this adds is the only migration a byte-faithful host is allowed: telling the author
  // the current spelling and letting them decide. Rewriting their source would be faster
  // and is forbidden — a version is the author's bytes, and a host that edits them to
  // suit its own vocabulary has broken the promise the whole provenance story rests on.
  if (raw.some((b) => b.legacy))
    advisories.push(
      `Written with the original spelling (\`${LEGACY_SCRIPT_TYPES[0]}\` / \`data-slot\`), which parses ` +
        `exactly the same and always will. The current spelling is \`${FACT_SCRIPT_TYPE}\` with ` +
        `\`${FACT_NAME_ATTR}="…"\` (markdown: \`\`\`${FACT_FENCE_LANG}). Switch when it suits you; ` +
        `nothing here rewrites what you published.`,
    )

  for (const block of raw) {
    if (facts.length >= MAX_FACTS_PER_VERSION) {
      advisories.push(
        `More than ${MAX_FACTS_PER_VERSION} facts — only the first ${MAX_FACTS_PER_VERSION} were stored, the rest ignored.`,
      )
      break
    }
    const name = block.slot
    if (!SLOT_NAME_RE.test(name)) {
      advisories.push(
        name
          ? `Facts "${name}" has an invalid name (use lowercase letters, digits and hyphens, up to 64 chars) — skipped.`
          : "A derive-data block has no fact name — skipped.",
      )
      continue
    }
    if (seen.has(name)) {
      advisories.push(`Facts "${name}" appears more than once — kept the first, skipped the rest.`)
      continue
    }
    const json = block.body.trim()
    try {
      JSON.parse(json)
    } catch {
      advisories.push(
        endsInsideString(json)
          ? `Facts "${name}" ends inside an unterminated string, which usually means its JSON contains a literal </script> — HTML ends the block there (a browser does the same), so only the text before it arrived. Escape it as <\\/script>. Nothing stored for this slot.`
          : `Facts "${name}" is not valid JSON — nothing stored for it.`,
      )
      continue
    }
    const bytes = byteLength(json)
    if (bytes > MAX_FACT_BYTES) {
      advisories.push(
        `Facts "${name}" is ${(bytes / 1024).toFixed(1)}KB, over the ${MAX_FACT_BYTES / 1024}KB limit — skipped.`,
      )
      continue
    }
    seen.add(name)
    facts.push({ slot: name, json, bytes })
  }

  return { facts, advisories }
}

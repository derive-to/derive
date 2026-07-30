/**
 * Structured data slots. An artifact is a document that an agent authored; a slot lets
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
export const SLOT_GEN = 1

/** Per-slot ceiling on the stored JSON text. Past it the slot is skipped with an advisory. */
export const MAX_SLOT_BYTES = 32 * 1024
/** Per-version ceiling on the number of slots. Extras are dropped with an advisory. */
export const MAX_SLOTS_PER_VERSION = 20

/** Slot names are url-safe and short: they appear in `read(data:"…")` and a raw route. */
const SLOT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** The script type that marks an HTML data block. Inert in every browser. */
export const DATA_SCRIPT_TYPE = "application/derive-data"
/** The markdown fence info word that marks a data block. */
export const DATA_FENCE_LANG = "derive-data"

/** One extracted, validated slot: the trimmed source text of the block and its byte size. */
export interface ParsedSlot {
  slot: string
  json: string
  bytes: number
}

export interface DataSlotResult {
  /** Slots that parsed, in document order, first-occurrence-wins, capped. */
  slots: ParsedSlot[]
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

// A <script …>…</script> block. JSON can't legally contain "</script>", so a
// non-greedy match to the first close is exactly the block's body — no DOM needed.
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi

// A fenced block opening with ```derive-data <slot> and closing on a line that is just
// ``` (optionally indented/padded). The name stops at whitespace or a backtick.
const FENCE_RE =
  /(^|\n)[ \t]*```[ \t]*derive-data[ \t]+([^\s`]+)[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*(?=\r?\n|$)/g

interface RawBlock {
  slot: string
  body: string
}

const htmlBlocks = (source: string): RawBlock[] => {
  const out: RawBlock[] = []
  SCRIPT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  m = SCRIPT_RE.exec(source)
  while (m) {
    const attrs = m[1] ?? ""
    // TRIMMED, like a browser reads a type attribute: `type="application/derive-data "`
    // is the same script to the HTML parser, and without the trim it was silently not a
    // data block at all — no slot, no advisory, nothing to notice.
    const type = attr(attrs, "type")?.trim()
    if (type?.toLowerCase() === DATA_SCRIPT_TYPE) {
      const slot = attr(attrs, "data-slot")?.trim()
      // A data-typed script with no data-slot is a usage error worth naming, but with no
      // name there's nothing to key it on — surface it as a synthetic empty name so the
      // validation pass below advises about it uniformly.
      out.push({ slot: slot ?? "", body: m[2] ?? "" })
    }
    m = SCRIPT_RE.exec(source)
  }
  return out
}

const markdownBlocks = (source: string): RawBlock[] => {
  const out: RawBlock[] = []
  FENCE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  m = FENCE_RE.exec(source)
  while (m) {
    out.push({ slot: m[2] ?? "", body: m[3] ?? "" })
    m = FENCE_RE.exec(source)
  }
  return out
}

/**
 * Extract every data slot from a single-file source. `contentType` selects the grammar
 * (text/html → script blocks; text/markdown → fences); any other type has no slots. First
 * occurrence of a name wins; a later duplicate, an invalid name, invalid JSON, an oversize
 * body, or a slot past the per-version cap each yields an advisory and is skipped. Pure and
 * total — safe to call twice (once to advise, once to persist) with identical results.
 */
/**
 * A slot's SHAPE: its sorted key paths with value kinds, e.g. `fail:number|pass:number`.
 * Two versions with the same shape are comparable; two with different shapes are not,
 * however similar they look.
 *
 * This exists because of the quiet way a trend read goes wrong. Nothing rejects a slot
 * whose keys drift — rename `pass` to `passed` at v20 and `versions:"all"` still returns
 * thirty happy-looking points that are silently two different metrics, with the break
 * invisible unless you read every one. A series that gets LESS trustworthy the longer it
 * runs is worse than no series, so the drift gets named at the moment it happens.
 *
 * Depth-limited and count-capped: a fingerprint is for comparison, not for describing an
 * arbitrarily deep document, and this runs on the publish path.
 */
export const slotShape = (value: unknown, depth = 0, prefix = ""): string => {
  const kind = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v)
  if (depth >= 3 || value === null || typeof value !== "object" || Array.isArray(value))
    return `${prefix}:${kind(value)}`
  const keys = Object.keys(value as Record<string, unknown>)
    .sort()
    .slice(0, 40)
  if (!keys.length) return `${prefix}:object`
  return keys
    .map((k) =>
      slotShape((value as Record<string, unknown>)[k], depth + 1, prefix ? `${prefix}.${k}` : k),
    )
    .join("|")
}

/** The shape of a stored slot's JSON, or null when it can't be parsed. */
export const shapeOfJson = (json: string): string | null => {
  try {
    return slotShape(JSON.parse(json))
  } catch {
    return null
  }
}

/**
 * Compare a version's slot shapes against the previous version's and describe any drift.
 * Empty when nothing changed, when a slot is new, or when a slot simply went away (both
 * are ordinary authoring, not a broken series). Pure: the caller supplies the previous
 * shapes, so this stays testable and Workers-safe.
 */
export const slotDriftAdvisories = (
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
      `Data slot "${s.slot}" changed shape from the previous version` +
        (gone.length ? ` (gone: ${gone.slice(0, 6).join(", ")})` : "") +
        (added.length ? ` (new: ${added.slice(0, 6).join(", ")})` : "") +
        `. Reading this slot across versions now mixes two shapes, and nothing else will ` +
        `tell you — if this was a rename, past versions still carry the old keys.`,
    )
  }
  return out
}

/** How many numeric table cells make a page "carrying data" rather than "mentioning a
 *  number". Deliberately conservative: a missed nudge costs nothing, a false one trains
 *  the reader to skip advisories, and that channel is load-bearing everywhere else. */
const DATA_TABLE_MIN_CELLS = 4

// A numeric cell: an HTML <td> or a markdown table cell whose whole content is a number
// (with optional %, $, commas, decimals, sign). Prose containing a figure never matches,
// because the CELL has to be the number.
const HTML_NUM_CELL = /<td[^>]*>\s*[-+$]?\d[\d,]*\.?\d*\s*%?\s*<\/td>/gi
const MD_TABLE_ROW = /^\s*\|.+\|\s*$/gm
const MD_NUM_CELL = /\|\s*[-+$]?\d[\d,]*\.?\d*\s*%?\s*(?=\|)/g

/**
 * Does this page carry FIGURES that no slot makes queryable? The nudge that turns slots
 * from a thing you must remember into a thing you get told about at the moment you would
 * have wanted it — the same move as every other advisory here, and the reason those exist:
 * correct-by-construction beats correct-by-vigilance.
 *
 * Written after watching an agent (me) build slots and then publish fifteen versions of
 * pages full of numbers without emitting a single one. The gap was never knowing how; it
 * was that nothing asked at the moment of publishing.
 *
 * Returns null when the page already carries a slot, when it has no tabular figures, or
 * when the content type has no slot grammar at all.
 */
export const missingDataSlotAdvisory = (source: string, contentType: string): string | null => {
  const ct = contentType.toLowerCase()
  const isHtml = ct.includes("html")
  if (!isHtml && !ct.includes("markdown")) return null
  // Already carries data (or tried to — a malformed block gets its own advisory).
  if (parseDataSlots(source, contentType).slots.length > 0) return null
  if (/derive-data/.test(source)) return null

  let cells = 0
  if (isHtml) {
    cells = (source.match(HTML_NUM_CELL) ?? []).length
  } else {
    for (const row of source.match(MD_TABLE_ROW) ?? [])
      cells += (row.match(MD_NUM_CELL) ?? []).length
  }
  if (cells < DATA_TABLE_MIN_CELLS) return null

  return (
    `This page carries ${cells} numeric table cells but no data slot, so those figures are ` +
    `readable only by parsing this markup — including by you, later, on every past version. ` +
    `A \`derive-data\` block (see the publishing skill) stores them per version, so ` +
    `read(data:"<name>", versions:"all") answers "how did this change over time" in one call. ` +
    `Ignorable: plenty of pages are prose that happens to contain a table.`
  )
}

export const parseDataSlots = (source: string, contentType: string): DataSlotResult => {
  const ct = contentType.toLowerCase()
  const raw = ct.includes("html")
    ? htmlBlocks(source)
    : ct.includes("markdown")
      ? markdownBlocks(source)
      : []

  const slots: ParsedSlot[] = []
  const advisories: string[] = []
  const seen = new Set<string>()

  for (const block of raw) {
    if (slots.length >= MAX_SLOTS_PER_VERSION) {
      advisories.push(
        `More than ${MAX_SLOTS_PER_VERSION} data slots — only the first ${MAX_SLOTS_PER_VERSION} were stored, the rest ignored.`,
      )
      break
    }
    const name = block.slot
    if (!SLOT_NAME_RE.test(name)) {
      advisories.push(
        name
          ? `Data slot "${name}" has an invalid name (use lowercase letters, digits and hyphens, up to 64 chars) — skipped.`
          : "A derive-data block has no slot name — skipped.",
      )
      continue
    }
    if (seen.has(name)) {
      advisories.push(
        `Data slot "${name}" appears more than once — kept the first, skipped the rest.`,
      )
      continue
    }
    const json = block.body.trim()
    try {
      JSON.parse(json)
    } catch {
      advisories.push(
        endsInsideString(json)
          ? `Data slot "${name}" ends inside an unterminated string, which usually means its JSON contains a literal </script> — HTML ends the block there (a browser does the same), so only the text before it arrived. Escape it as <\\/script>. Nothing stored for this slot.`
          : `Data slot "${name}" is not valid JSON — nothing stored for it.`,
      )
      continue
    }
    const bytes = byteLength(json)
    if (bytes > MAX_SLOT_BYTES) {
      advisories.push(
        `Data slot "${name}" is ${(bytes / 1024).toFixed(1)}KB, over the ${MAX_SLOT_BYTES / 1024}KB limit — skipped.`,
      )
      continue
    }
    seen.add(name)
    slots.push({ slot: name, json, bytes })
  }

  return { slots, advisories }
}

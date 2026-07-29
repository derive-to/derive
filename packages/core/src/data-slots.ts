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
    const type = attr(attrs, "type")
    if (type?.toLowerCase() === DATA_SCRIPT_TYPE) {
      const slot = attr(attrs, "data-slot")
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
      advisories.push(`Data slot "${name}" is not valid JSON — nothing stored for it.`)
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

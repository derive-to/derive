/**
 * Element anchors — pin a comment to a NON-TEXT element (an image, chart, table,
 * embed, code block, figure …) instead of a quoted span. Text comments ride a
 * `TextQuoteSelector` (see `anchor.ts`); this is its sibling for everything that
 * isn't prose.
 *
 * The hard part is surviving a republish. An element has no "exact text" to grep
 * for, so a single signal is brittle: ids get regenerated, css paths shift when a
 * wrapper is added, an image's position drifts as content lands above it. So we
 * record SEVERAL independent signals and resolve by AGREEMENT — a layered cascade,
 * strongest to weakest:
 *
 *   id → css → content fingerprint → structural ordinal → geometry → neighbors
 *
 * Each signal that agrees with a candidate adds to its score; the best-scoring
 * element wins, carrying a `confidence` (0..1) and a coarse band. One strong
 * signal (a matching id or an identical content fingerprint) is enough; absent
 * those, several weak ones in agreement still relocate the element. Nothing here
 * uses ML — it's deterministic and runs identically in the browser (live, against
 * the real DOM) and on the server (against a version's HTML, via `scanElements`).
 *
 * Two things make element anchors more than a worse text anchor:
 *
 *   1. A preserved SNAPSHOT. We capture what the element looked like at comment
 *      time (label, src, a truncated outerHTML). If the element is later gone, the
 *      orphaned comment still shows what it pointed at instead of a dead marker.
 *
 *   2. Forward-walk RECOVERY (the Derive-only advantage). Because Derive keeps every
 *      version's full HTML, when an anchor can't resolve in the current version we
 *      walk the version history forward from where it was made, re-deriving the
 *      selector at each step it still resolves. An element that was renamed, moved,
 *      or rewrapped one version at a time is recovered — each hop is a small,
 *      resolvable delta even though first-to-last looks unrecognizable.
 *
 * The fingerprint hash (`fnv1a`) is duplicated verbatim inside `ANCHOR_CLIENT_JS`
 * so a fingerprint computed in the browser equals one computed here — keep them in
 * lockstep if you touch the input shape.
 */

export type ElementRole =
  | "image"
  | "chart"
  | "media"
  | "embed"
  | "table"
  | "code"
  | "figure"
  | "block"

/** What the element looked like when the comment was made — shown when the live
 *  element can no longer be found, so an orphaned comment still has a referent. */
export interface ElementSnapshot {
  tag: string
  /** Human descriptor, e.g. "Image — revenue.png", "Table (4×3)", "Embedded video". */
  label: string
  /** Normalized text content (truncated). */
  text?: string
  /** img/video/iframe/embed source, if any. */
  src?: string
  /** alt / aria-label / title / caption, if any. */
  alt?: string
  /** Displayed size at capture (for a placeholder aspect ratio). */
  w?: number
  h?: number
  /** Truncated outerHTML for a visual preview. Sanitized again at render time. */
  html?: string
}

export interface ElementSelector {
  type: "ElementSelector"
  tag: string
  role: ElementRole
  /** Element id — only recorded when it looks authored (not a hashy/generated id). */
  id?: string
  /** Structural css path (`tag:nth-of-type(n)` chain). Captured + verified in the
   *  browser, where a real DOM exists; the server cascade skips it. */
  css?: string
  /** Content hash over {tag, src, alt, leading text}. The single strongest signal. */
  fingerprint: string
  /** 0-based index among same-tag elements in document order. */
  ordinal: number
  /** Vertical position at capture as a fraction of the document (0..1) — "save
   *  position". A weak geometric tiebreaker; the server approximates it from the
   *  element's offset in the HTML source. */
  docFraction: number
  /** Normalized text of the nearest preceding / following text-bearing block. */
  before?: string
  after?: string
  snapshot: ElementSnapshot
  /** Deck artifacts only: the 0-based slide the comment was made on. */
  slide?: number
}

/** A flat, parent-free description of one element, the server-side stand-in for a
 *  live DOM node (we ship no HTML parser, so `scanElements` builds these). */
export interface ElementDescriptor {
  tag: string
  id?: string
  classes: string[]
  /** Selected attributes only (src/href/alt/title/aria-label/role/data-*). */
  attrs: Record<string, string>
  /** Normalized subtree text (truncated). */
  text: string
  /** 0-based index among same-tag elements, document order. */
  ordinal: number
  /** Global element index in document order. */
  index: number
  /** Index of the enclosing element (-1 at top level). Lets neighbour lookup skip
   *  ancestors/descendants so a wrapped element (`<div><img><p>…`) resolves the same
   *  preceding/following block the browser-side walk does. */
  parent: number
  /** Start offset in the HTML source / total length (0..1) — geometry proxy. */
  srcFraction: number
}

export type ConfidenceBand = "high" | "medium" | "low"

export interface ElementMatch {
  /** Index into the `ElementDescriptor[]` passed to `resolveElement`. */
  index: number
  confidence: number
  band: ConfidenceBand
  /** Which signals agreed — useful for debugging + UI ("matched by id, content"). */
  signals: string[]
}

const TEXT_CAP = 4000
const FP_TEXT_CAP = 120
/** Field separator inside a content fingerprint, so a value ending and the next
 *  beginning can't blur into a collision (e.g. src "...a" + alt "b" vs src "..." +
 *  alt "ab"). A control char that never appears in real content. MUST stay identical
 *  to the client's `elFp` join in `ANCHOR_CLIENT_JS` — they were silently different
 *  ("" vs this) once, which made every browser-made anchor fail to resolve server-side. */
const FP_SEP = "\u0001"

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
])
const RAW_TAGS = new Set(["script", "style"])
/** Block-level tags whose opening implicitly closes an open `<p>` (HTML's optional
 *  end-tag rule). */
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
])
/**
 * Does an open element `open` get implicitly closed when `next` opens? Browsers
 * apply these optional-end-tag rules, so the scanner must too — otherwise an
 * unclosed `<p>`/`<li>`/`<td>` nests its siblings and an element's neighbour text
 * diverges from the live DOM (`"beforeafter"` vs `"before"`), making the server's
 * `anchored` check disagree with the painted overlay.
 */
function autoCloses(open: string, next: string): boolean {
  switch (open) {
    case "p":
      return BLOCK_TAGS.has(next)
    case "li":
      return next === "li"
    case "dt":
    case "dd":
      return next === "dt" || next === "dd"
    case "td":
    case "th":
      return next === "td" || next === "th" || next === "tr"
    case "tr":
      return next === "tr"
    case "option":
      return next === "option" || next === "optgroup"
    case "thead":
    case "tbody":
      return next === "tbody" || next === "tfoot"
    default:
      return false
  }
}
/** Tags that never carry standalone visual meaning — not anchor targets. */
const SKIP_TAGS = new Set([
  "html",
  "head",
  "body",
  "script",
  "style",
  "meta",
  "link",
  "title",
  "base",
  "noscript",
])
/** Attributes worth keeping for fingerprinting / role detection. */
const KEEP_ATTRS = new Set([
  "src",
  "href",
  "alt",
  "title",
  "aria-label",
  "role",
  "name",
  "data-derive-slide",
  "data-derive-id",
])

/** Collapse runs of whitespace and trim. Used everywhere a value feeds matching. */
export function normWs(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

/**
 * FNV-1a (32-bit) → base36. A tiny, fast, dependency-free hash — we only need a
 * stable content fingerprint, not cryptographic strength. DUPLICATED VERBATIM in
 * `ANCHOR_CLIENT_JS`; the browser and server must produce identical fingerprints.
 */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(36)
}

const srcOf = (d: { tag: string; attrs: Record<string, string> }): string =>
  d.attrs.src || d.attrs.href || ""
const altOf = (d: { attrs: Record<string, string> }): string =>
  d.attrs.alt || d.attrs["aria-label"] || d.attrs.title || ""

/** The canonical fingerprint input — keep byte-identical with the client. */
export function fingerprintOf(d: {
  tag: string
  attrs: Record<string, string>
  text: string
}): string {
  const parts = [d.tag, srcOf(d), altOf(d), normWs(d.text).slice(0, FP_TEXT_CAP)]
  return fnv1a(parts.join(FP_SEP))
}

/** Classify an element into a coarse role for labels + capture affordances. */
export function roleOf(d: {
  tag: string
  id?: string
  classes: string[]
  attrs: Record<string, string>
}): ElementRole {
  const tag = d.tag
  // Concrete media tags win outright — an <img> is an image even if its id says
  // "chart". The textual hint only disambiguates generic containers below.
  if (tag === "img" || tag === "picture") return "image"
  if (tag === "video" || tag === "audio") return "media"
  if (tag === "iframe" || tag === "embed" || tag === "object") return "embed"
  if (tag === "table") return "table"
  if (tag === "pre" || tag === "code") return "code"
  if (tag === "svg" || tag === "canvas") return "chart"
  if (tag === "figure") return "figure"
  const hint = `${d.classes.join(" ")} ${d.id ?? ""} ${d.attrs.role ?? ""}`.toLowerCase()
  if (/\b(chart|graph|plot|viz|sparkline|d3)\b/.test(hint)) return "chart"
  return "block"
}

/** A short, human label for the snapshot / orphan card. */
export function elementLabel(d: {
  tag: string
  role: ElementRole
  attrs: Record<string, string>
  text?: string
}): string {
  const alt = normWs(altOf(d))
  const host = hostOf(d.attrs.src || d.attrs.href || "")
  switch (d.role) {
    case "image":
      return alt ? `Image — ${truncate(alt, 48)}` : host ? `Image — ${host}` : "Image"
    case "chart":
      return alt ? `Chart — ${truncate(alt, 48)}` : "Chart"
    case "media":
      return d.tag === "audio" ? "Audio" : host ? `Video — ${host}` : "Video"
    case "embed":
      return host ? `Embedded — ${host}` : "Embedded content"
    case "table":
      return "Table"
    case "code":
      return "Code block"
    case "figure":
      return alt ? `Figure — ${truncate(alt, 48)}` : "Figure"
    default:
      return truncate(normWs(d.text ?? "") || d.tag, 48) || "Element"
  }
}

function hostOf(url: string): string {
  if (!url) return ""
  const m = url.match(/^https?:\/\/([^/]+)/i)
  if (m?.[1]) return m[1].replace(/^www\./, "")
  return ""
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/**
 * Parse HTML into an ordered list of element descriptors — a dependency-free
 * substitute for a DOM, enough to run the cascade server-side. Not a spec-complete
 * parser: it tokenizes tags, tracks open/close to accumulate subtree text and
 * same-tag ordinals, skips raw (`script`/`style`) content and comments, and drops
 * structural/non-visual tags. Malformed nesting degrades gracefully (a missing
 * close just keeps text flowing into ancestors) — fine for a best-effort relocator.
 */
export function scanElements(html: string): ElementDescriptor[] {
  const out: ElementDescriptor[] = []
  const total = html.length || 1
  // Open-element frames; text is pushed onto every open frame (subtree text).
  const stack: { d: ElementDescriptor; parts: string[]; len: number }[] = []
  const tagCount: Record<string, number> = {}
  let i = 0
  let order = 0
  const n = html.length

  const pushText = (raw: string) => {
    if (!raw) return
    for (const f of stack) {
      if (f.len >= TEXT_CAP) continue
      const room = TEXT_CAP - f.len
      const slice = raw.length > room ? raw.slice(0, room) : raw
      f.parts.push(slice)
      f.len += slice.length
    }
  }

  while (i < n) {
    const lt = html.indexOf("<", i)
    if (lt < 0) {
      pushText(decodeEntities(html.slice(i)))
      break
    }
    if (lt > i) pushText(decodeEntities(html.slice(i, lt)))

    // Comment / CDATA / doctype — skip wholesale.
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4)
      i = end < 0 ? n : end + 3
      continue
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt)
      i = end < 0 ? n : end + 1
      continue
    }

    // Closing tag.
    if (html[lt + 1] === "/") {
      const end = html.indexOf(">", lt)
      const name = html
        .slice(lt + 2, end < 0 ? n : end)
        .trim()
        .toLowerCase()
      // Pop to the nearest matching open frame (tolerate unclosed children).
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s]?.d.tag === name) {
          for (let k = stack.length - 1; k >= s; k--) finalize(stack.pop())
          break
        }
      }
      i = end < 0 ? n : end + 1
      continue
    }

    // Opening tag.
    const end = tagEnd(html, lt)
    if (end < 0) {
      pushText(decodeEntities(html.slice(lt)))
      break
    }
    const inner = html.slice(lt + 1, end)
    const sp = firstSpace(inner)
    const tag = (sp < 0 ? inner : inner.slice(0, sp)).trim().toLowerCase().replace(/\/$/, "")
    const selfClose = inner.trimEnd().endsWith("/")
    i = end + 1

    if (!tag || /[^a-z0-9-]/.test(tag)) continue

    if (RAW_TAGS.has(tag)) {
      // Skip the raw element's content entirely (it may contain `<`).
      const close = html.toLowerCase().indexOf(`</${tag}`, i)
      i = close < 0 ? n : html.indexOf(">", close) + 1 || n
      continue
    }

    const attrs = parseAttrs(sp < 0 ? "" : inner.slice(sp + 1))
    if (SKIP_TAGS.has(tag)) continue

    // Apply HTML optional-end-tag rules: pop any open elements this tag implicitly
    // closes (an open <p> before a block, <li> before <li>, <td> before <td>/<tr>…),
    // so neighbour text matches what the browser's DOM produces.
    while (stack.length) {
      const top = stack[stack.length - 1]
      if (top && autoCloses(top.d.tag, tag)) finalize(stack.pop())
      else break
    }

    const ordinal = tagCount[tag] ?? 0
    tagCount[tag] = ordinal + 1
    const d: ElementDescriptor = {
      tag,
      id: attrs.id || undefined,
      classes: attrs.class ? attrs.class.split(/\s+/).filter(Boolean) : [],
      attrs: pickAttrs(attrs),
      text: "",
      ordinal,
      index: order++,
      parent: stack.length ? (stack[stack.length - 1]?.d.index ?? -1) : -1,
      srcFraction: lt / total,
    }
    out.push(d)
    if (selfClose || VOID_TAGS.has(tag)) continue
    stack.push({ d, parts: [], len: 0 })
  }
  while (stack.length) finalize(stack.pop())
  return out

  function finalize(f?: { d: ElementDescriptor; parts: string[] }) {
    if (f) f.d.text = normWs(f.parts.join(""))
  }
}

/** Index of the `>` that closes the tag opened at `lt`, respecting quoted attrs. */
function tagEnd(html: string, lt: number): number {
  let q = ""
  for (let j = lt + 1; j < html.length; j++) {
    const ch = html[j]
    if (q) {
      if (ch === q) q = ""
    } else if (ch === '"' || ch === "'") q = ch
    else if (ch === ">") return j
  }
  return -1
}

function firstSpace(s: string): number {
  const m = s.match(/[\s/]/)
  return m ? (m.index ?? -1) : -1
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((m = re.exec(s))) {
    const name = m[1]?.toLowerCase()
    if (!name) continue
    // Duplicate attributes are invalid HTML, but they happen. The parsing spec (and
    // every browser) keeps the FIRST occurrence and ignores the rest — match that, so
    // a fingerprint here equals one read off a live `getAttribute`.
    if (name in out) continue
    let val = m[2] ?? ""
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1)
    out[name] = decodeEntities(val)
  }
  return out
}

function pickAttrs(all: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of Object.keys(all)) {
    if (KEEP_ATTRS.has(k) || k.startsWith("data-")) out[k] = all[k] as string
  }
  return out
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
}
function decodeEntities(s: string): string {
  if (s.indexOf("&") < 0) return s
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const cp =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10)
      return Number.isFinite(cp) ? safeFromCodePoint(cp) : whole
    }
    return ENTITIES[body] ?? whole
  })
}
function safeFromCodePoint(cp: number): string {
  try {
    return String.fromCodePoint(cp)
  } catch {
    return ""
  }
}

// --- The cascade --------------------------------------------------------------

/** Signal weights, strongest → weakest. id and fingerprint each alone clear the
 *  acceptance threshold; the rest accumulate. */
const W = {
  id: 5,
  fingerprint: 5,
  tagOrdinal: 3,
  tagOnly: 1,
  neighbor: 1, // per side (before/after) → up to 2
  geometry: 1,
}
const ACCEPT = 0.42

/**
 * Resolve an element selector against a parsed document. Scores every same-tag
 * candidate (plus an id match of any tag) by signal agreement and returns the best
 * if it clears the threshold, with a confidence and the signals that agreed.
 * Pure; the browser runs the same cascade against live elements.
 */
export function resolveElement(
  sel: ElementSelector,
  descriptors: ElementDescriptor[],
): ElementMatch | null {
  if (!descriptors.length) return null
  // Candidate set: same tag, plus any element carrying the recorded id. Track how
  // many share the recorded fingerprint / id — a strong signal that matches MANY
  // candidates isn't identifying, so it can't grant high confidence (a gallery of
  // identical thumbnails, two charts on the same blank canvas).
  const candidates = new Set<number>()
  let fpMatches = 0
  let idMatches = 0
  for (let i = 0; i < descriptors.length; i++) {
    const d = descriptors[i]
    if (!d) continue
    if (d.tag === sel.tag) candidates.add(i)
    if (sel.id && d.id === sel.id) {
      candidates.add(i)
      idMatches++
    }
    if (fingerprintOf(d) === sel.fingerprint) fpMatches++
  }
  if (!candidates.size) return null

  let best: ElementMatch | null = null
  let runnerUp = 0 // second-best confidence — a thin margin means the pick is a guess
  for (const idx of candidates) {
    const d = descriptors[idx]
    if (!d) continue
    let score = 0
    let max = 0
    const signals: string[] = []

    if (sel.id) {
      max += W.id
      if (d.id === sel.id) {
        score += W.id
        signals.push("id")
      }
    }

    max += W.fingerprint
    if (fingerprintOf(d) === sel.fingerprint) {
      score += W.fingerprint
      signals.push("content")
    }

    // Structural ordinal — a corroborator for a UNIQUE element. But when the content
    // fingerprint repeats across candidates (the same logo on every slide, a gallery),
    // ordinal is exactly the signal a single insertion/deletion scrambles, so it's
    // untrustworthy and actively misleading: drop it and let neighbors + geometry pick
    // WHICH instance. (Without this, a comment on slide 3's logo jumps to slide 2's
    // when a slide is inserted, because the old ordinal now points there.)
    if (fpMatches <= 1) {
      max += W.tagOrdinal
      if (d.tag === sel.tag) {
        if (d.ordinal === sel.ordinal) {
          score += W.tagOrdinal
          signals.push("position")
        } else {
          score += W.tagOnly
        }
      }
    }

    // Neighbors — the text just before / after the element.
    if (sel.before || sel.after) {
      const { before, after } = neighborText(descriptors, idx)
      for (const [want, got, name] of [
        [sel.before, before, "before"],
        [sel.after, after, "after"],
      ] as const) {
        if (!want) continue
        max += W.neighbor
        if (got && textClose(want, got)) {
          score += W.neighbor
          signals.push(`neighbor:${name}`)
        }
      }
    }

    // Geometry — closeness of source position (weak tiebreaker, always considered).
    max += W.geometry
    const geo = 1 - Math.min(1, Math.abs(d.srcFraction - sel.docFraction))
    score += W.geometry * geo

    const confidence = max > 0 ? score / max : 0
    if (!best || confidence > best.confidence) {
      if (best) runnerUp = Math.max(runnerUp, best.confidence)
      best = { index: idx, confidence, band: "low", signals }
    } else if (confidence > runnerUp) {
      runnerUp = confidence
    }
  }

  if (!best || best.confidence < ACCEPT) return null
  const { band, confidence } = grade(best, {
    fpMatches,
    idMatches,
    margin: best.confidence - runnerUp,
  })
  best.band = band
  best.confidence = confidence
  return best
}

/**
 * Turn the winner's raw score into a confidence band, accounting for ambiguity.
 * The raw ratio over-credits a strong signal that fired on MANY candidates: if the
 * fingerprint (or id) isn't unique, "content matched" says nothing about WHICH
 * element, so the pick leans on position/geometry — exactly the signals a deletion
 * scrambles. So an ambiguous strong signal, or a thin margin over the runner-up,
 * caps the band (and the reported confidence) down to "we think it moved here".
 */
function grade(
  m: ElementMatch,
  ctx: { fpMatches: number; idMatches: number; margin: number },
): { band: ConfidenceBand; confidence: number } {
  const matchedId = m.signals.includes("id")
  const matchedContent = m.signals.includes("content")
  const hasNeighbor = m.signals.some((s) => s.startsWith("neighbor"))
  // A strong signal that uniquely identifies this element (only one candidate has it).
  const strongUnique = (matchedId && ctx.idMatches === 1) || (matchedContent && ctx.fpMatches === 1)
  // A strong signal shared across candidates — not identifying on its own.
  const strongAmbiguous = (matchedId && ctx.idMatches > 1) || (matchedContent && ctx.fpMatches > 1)
  // The OTHER strong signal points at a DIFFERENT element than the winner — id and
  // content disagree (two charts swapped src/alt but kept their ids, or an id was
  // reused for different content). A genuine conflict, so never "high".
  const conflict =
    (matchedId && !matchedContent && ctx.fpMatches > 0) ||
    (matchedContent && !matchedId && ctx.idMatches > 0)

  // Ambiguous strong signal with nothing reliable to break the tie (only position /
  // geometry, which a deletion shifts) → low, and don't report a confident number.
  if (strongAmbiguous && !strongUnique && !hasNeighbor) {
    return { band: "low", confidence: Math.min(m.confidence, 0.45) }
  }
  // id says one element, content says another → medium at most, flagged as moved.
  if (conflict) {
    return { band: "medium", confidence: Math.min(m.confidence, 0.6) }
  }
  if (strongUnique && m.confidence >= 0.6 && ctx.margin >= 0.12) {
    return { band: "high", confidence: m.confidence }
  }
  if ((strongUnique || hasNeighbor || m.signals.includes("position")) && m.confidence >= 0.5) {
    return { band: "medium", confidence: Math.min(m.confidence, 0.75) }
  }
  return { band: "low", confidence: Math.min(m.confidence, 0.5) }
}

/** Nearest text-bearing block before/after `idx` in document order. */
function neighborText(ds: ElementDescriptor[], idx: number): { before?: string; after?: string } {
  // Is `a` an ancestor of `b` (walk b's parent chain)?
  const isAncestor = (a: number, b: number): boolean => {
    for (let p = ds[b]?.parent ?? -1; p >= 0; p = ds[p]?.parent ?? -1) if (p === a) return true
    return false
  }
  let before: string | undefined
  for (let i = idx - 1, seen = 0; i >= 0 && seen < 6; i--) {
    if (isAncestor(i, idx)) continue // an enclosing container is not a preceding block
    seen++
    const t = ds[i]?.text
    if (t && t.length >= 2) {
      before = t
      break
    }
  }
  let after: string | undefined
  for (let i = idx + 1, seen = 0; i < ds.length && seen < 6; i++) {
    if (isAncestor(idx, i)) continue // a descendant is not a following block
    seen++
    const t = ds[i]?.text
    if (t && t.length >= 2) {
      after = t
      break
    }
  }
  return { before, after }
}

/** Loose text agreement for neighbors — exact, prefix, or containment of a
 *  meaningful chunk. Neighbors get edited too, so don't demand equality. */
function textClose(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false // defensive: hostile anchor
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  if (x === y) return true
  const short = x.length < y.length ? x : y
  const long = x.length < y.length ? y : x
  if (short.length >= 8 && long.includes(short)) return true
  // Shared 16-char leading window survives a trailing edit.
  const w = Math.min(16, short.length)
  return w >= 8 && long.slice(0, w) === short.slice(0, w)
}

/**
 * Re-derive a selector from the element it just matched, so the cascade tracks an
 * element as it's edited version-to-version (a renamed id, a moved position, a
 * rewrapped node). Carries the snapshot + slide through unchanged.
 */
export function rederiveSelector(
  sel: ElementSelector,
  d: ElementDescriptor,
  descriptors: ElementDescriptor[],
): ElementSelector {
  const { before, after } = neighborText(descriptors, d.index)
  return {
    ...sel,
    tag: d.tag,
    id: d.id,
    fingerprint: fingerprintOf(d),
    ordinal: d.ordinal,
    docFraction: d.srcFraction,
    before: before ?? sel.before,
    after: after ?? sel.after,
  }
}

export interface ForwardWalk {
  /** Did the (possibly re-derived) selector resolve in the final version? */
  resolved: boolean
  confidence: number
  band: ConfidenceBand
  /** The selector carried forward (re-derived at each hop it resolved). */
  selector: ElementSelector
  /** How many version hops it survived before being lost (or reaching the end). */
  survived: number
}

/**
 * Forward-walk recovery — the Derive-only move. Given a selector and the ORDERED
 * HTML of each version after the one it was made on (oldest → current), re-resolve
 * at each hop and re-derive the selector from the match before the next hop. An
 * element edited gradually (renamed, moved, rewrapped) is recovered because every
 * single-version delta stays resolvable even when first-vs-last does not. Stops at
 * the first version where it can't be found; reports whether it survives to the end.
 */
export function planElementForwardWalk(start: ElementSelector, versionHtml: string[]): ForwardWalk {
  let sel = start
  let survived = 0
  let last: ElementMatch | null = null
  for (const html of versionHtml) {
    const ds = scanElements(html)
    const m = resolveElement(sel, ds)
    if (!m) {
      return {
        resolved: false,
        confidence: 0,
        band: "low",
        selector: sel,
        survived,
      }
    }
    const d = ds[m.index]
    if (d) sel = rederiveSelector(sel, d, ds)
    last = m
    survived++
  }
  return {
    resolved: !!last,
    confidence: last?.confidence ?? 0,
    band: last?.band ?? "low",
    selector: sel,
    survived,
  }
}

/** Parse a stored anchor JSON as an ElementSelector (or null if it's something
 *  else — a text quote, malformed, or absent). Anchors are written by clients, so
 *  every field is validated/coerced to its expected type: a hostile or buggy anchor
 *  (e.g. a non-string `before`) must NOT be able to crash resolution — the sweep
 *  runs on every publish, so a throw here would break publishing for the artifact. */
export function parseElementSelector(json: string | null): ElementSelector | null {
  if (!json) return null
  let s: Record<string, unknown>
  try {
    const parsed = JSON.parse(json)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    s = parsed as Record<string, unknown>
  } catch {
    return null
  }
  if (s.type !== "ElementSelector") return null
  const tag = typeof s.tag === "string" ? s.tag : ""
  const fingerprint = typeof s.fingerprint === "string" ? s.fingerprint : ""
  if (!tag || !fingerprint) return null
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback
  const snap =
    s.snapshot && typeof s.snapshot === "object" ? (s.snapshot as ElementSnapshot) : undefined
  return {
    type: "ElementSelector",
    tag,
    role: (typeof s.role === "string" ? s.role : "block") as ElementRole,
    id: str(s.id),
    css: str(s.css),
    fingerprint,
    ordinal: num(s.ordinal, 0),
    docFraction: Math.max(0, Math.min(1, num(s.docFraction, 0))),
    before: str(s.before),
    after: str(s.after),
    snapshot: snap ?? { tag, label: tag },
    slide: typeof s.slide === "number" && Number.isFinite(s.slide) ? s.slide : undefined,
  }
}

/** True if a stored anchor is an element anchor (vs a text quote / unanchored). */
export function isElementAnchor(json: string | null): boolean {
  return parseElementSelector(json) !== null
}

/** Does an element anchor still resolve against this page's HTML? */
export function elementResolvesIn(sel: ElementSelector, html: string): ElementMatch | null {
  return resolveElement(sel, scanElements(html))
}

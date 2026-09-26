/**
 * The frame half of exact-source editing: what changed in the edited DOM, as
 * operations on the stored source that the server applies by element id.
 *
 * When an editor opens an HTML artifact, the server stamps `data-derive-src="N"` on
 * every element start tag, N being that tag's position in the stored source. At the
 * start of an edit session the frame records each stamped element's children (text,
 * and which stamped elements, in order). At save, every element whose children
 * differ from that record becomes one `content` op: its new children as tokens.
 * Given the elements the person touched, only those can: the page's own scripts keep
 * running while you edit, and what they change is not an edit.
 * `keep(N)` copies element N's source bytes verbatim, so moved, untouched, or merely
 * re-parented elements keep every attribute, entity, and comment inside them. Only
 * the outermost changed element carries an op; changes inside it ride along as
 * `keep(N, children)`, so ops never nest.
 *
 * What the browser invents while editing (a styled span when blocks merge, a div on
 * Enter, a font tag) has no stamp and is unwrapped into its text; the editor's own
 * formatting spans and any bold/italic become the inline tags the server allows.
 * Elements a page script made before the session are not in the source at all and
 * are skipped. Comments ride along verbatim.
 *
 * DOM-agnostic on purpose: no document or window globals, only the nodes passed in,
 * so the serializer can be exercised against a real browser DOM in tests. Frame-only:
 * not exported from the package index (its DOM types don't exist on the server).
 * Hashes are left empty; the host fills them from the source map.
 */

import type { SourceInlineTag, SourceOp, SourceToken } from "./source-edit"

export const SRC_ATTR = "data-derive-src"
/** Marks what a page script generated before the session: not in the source. */
export const GEN_ATTR = "data-derive-generated"
/** The editor's own formatting spans (see applyFmt / insertBreak in the client). */
export const FMT_ATTR = "data-derive-fmt"
export const HREF_ATTR = "data-derive-href"
/** A line break the editor adds to hold a line open (a paragraph Enter left empty, a
 *  break at the end of a block). It saves as a <br> only while it is what holds that
 *  line (nothing before it, or a break right before it); beside words it is redundant. */
export const HOLD_ATTR = "data-derive-hold"
/** Editor chrome that lives in the page but never in the source. */
const CHROME = ".derive-edit-ui,.derive-el-hl"
/** Editor wraps around source text (mention chips): transparent. */
const WRAP = ".derive-mention"
const BLOCKISH =
  /^(?:address|article|aside|blockquote|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|li|main|nav|ol|p|pre|section|ul)$/

/** An element's source id, or null when the browser or a script made it. */
export const srcOf = (el: Element): number | null => {
  const v = el.getAttribute(SRC_ATTR)
  return v !== null && /^\d+$/.test(v) ? Number(v) : null
}

type Kind = "chrome" | "wrap" | "src" | "gen" | "fmt" | "new"
const kindOf = (el: Element): Kind =>
  el.matches(CHROME)
    ? "chrome"
    : el.matches(WRAP)
      ? "wrap"
      : srcOf(el) !== null
        ? "src"
        : el.hasAttribute(GEN_ATTR)
          ? "gen"
          : el.hasAttribute(FMT_ATTR)
            ? "fmt"
            : "new"

/** An element's children as one comparable string: text (merged across node
 *  splits), stamped children by id, and anything new by tag. */
const sigOf = (el: Element): string => {
  let out = ""
  let text = ""
  const flush = () => {
    if (text) out += `\u0001${text}`
    text = ""
  }
  const walk = (parent: Element) => {
    for (let n = parent.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) text += (n as Text).data
      if (n.nodeType !== 1) continue
      const c = n as Element
      const k = kindOf(c)
      if (k === "wrap") walk(c)
      else if (k === "src") {
        flush()
        out += `\u0002${srcOf(c)}`
      } else if (k === "fmt" || k === "new") {
        flush()
        out += `\u0003${c.localName}${c.getAttribute(FMT_ATTR) ?? ""}`
      }
    }
  }
  walk(el)
  flush()
  return out
}

export interface SrcSnapshot {
  sigs: Map<number, string>
  /** The stamped elements themselves: a copy made later shares its original's id
   *  (and so its record) but is not one of these. */
  els: WeakSet<Element>
  /** Ids the browser's parser stamped on more than one element (it cloned a
   *  formatting element while repairing markup). Never expressible: fail closed. */
  dupes: Set<number>
}

/** Record every stamped element's children and mark script-made elements. Call once
 *  at the start of an edit session, after the page settled. */
export function snapshotSource(root: Element): SrcSnapshot {
  const sigs = new Map<number, string>()
  const dupes = new Set<number>()
  const els = new WeakSet<Element>()
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const k = kindOf(el)
    if (k === "new" && !el.closest(CHROME)) el.setAttribute(GEN_ATTR, "")
    if (k !== "src") continue
    const n = srcOf(el) as number
    els.add(el)
    if (sigs.has(n)) dupes.add(n)
    sigs.set(n, sigOf(el))
  }
  // An unstamped root (a body the server left bare) is recorded too, so a change
  // directly under it is caught instead of silently dropped.
  if (srcOf(root) === null) sigs.set(-1, sigOf(root))
  return { sigs, dupes, els }
}

/** Undo what snapshotSource marked on the page. */
export function releaseSource(root: Element): void {
  for (const el of Array.from(root.querySelectorAll(`[${GEN_ATTR}]`))) el.removeAttribute(GEN_ATTR)
}

/**
 * The `content` ops that turn the snapshot's source into what `root` shows now,
 * limited to `touched` elements (and copies made inside them) when given. `ok` is
 * false when a change can't be expressed (a script-made element holding source, a
 * parser-duplicated id): the caller must not save a partial picture. Ops carry no hashes; the host fills them
 * from the source map.
 */
export function collectSourceOps(
  root: Element,
  snap: SrcSnapshot,
  touched?: ReadonlySet<Element>,
): { ops: SourceOp[]; ok: boolean } {
  // A copy made inside something the person touched (Duplicate, a pasted copy, the
  // second half of an Enter) is theirs too, typed in or not: it shares its original's
  // id, so it is compared with the original's record and any difference is saved.
  const mine = (el: Element): boolean =>
    !touched ||
    touched.has(el) ||
    (!snap.els.has(el) && !!el.parentElement && el !== root && mine(el.parentElement))
  let ok = srcOf(root) !== null || !mine(root) || sigOf(root) === snap.sigs.get(-1)
  // Stamped elements whose own children changed, and every ancestor of one.
  const changed = new Set<Element>()
  const dirty = new Set<Element>()
  for (const el of Array.from(root.querySelectorAll(`[${SRC_ATTR}]`))) {
    const n = srcOf(el)
    if (n === null || !mine(el) || sigOf(el) === snap.sigs.get(n)) continue
    changed.add(el)
    for (let a: Element | null = el; a && !dirty.has(a); a = a.parentElement) dirty.add(a)
  }
  const tokensOf = (el: Element): SourceToken[] => {
    const out: SourceToken[] = []
    const text = (s: string) => {
      const last = out[out.length - 1]
      if (last && "text" in last) last.text += s
      else if (s) out.push({ text: s })
    }
    const lineBreak = () => {
      const last = out[out.length - 1]
      if (last && !("tag" in last && last.tag === "br")) out.push({ tag: "br" })
    }
    const walk = (parent: Element) => {
      for (let n = parent.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) text((n as Text).data)
        if (n.nodeType === 8) out.push({ comment: (n as Comment).data })
        if (n.nodeType !== 1) continue
        const c = n as Element
        if (c.hasAttribute(HOLD_ATTR)) {
          const last = [...out].reverse().find((t) => !("text" in t) || t.text.trim())
          if (!last || ("tag" in last && last.tag === "br")) out.push({ tag: "br" })
          continue
        }
        const k = kindOf(c)
        if (k === "chrome") continue
        if (k === "wrap") walk(c)
        else if (k === "src") {
          const id = srcOf(c) as number
          if (snap.dupes.has(id)) ok = false
          out.push(
            dirty.has(c) ? { keep: id, hash: "", children: tokensOf(c) } : { keep: id, hash: "" },
          )
        } else if (k === "gen") {
          // Not in the source, so not ours to write — unless it now holds source.
          if (c.querySelector(`[${SRC_ATTR}]`)) ok = false
        } else if (k === "fmt") {
          const f = c.getAttribute(FMT_ATTR)
          // A line break span holds its <br>, and whatever was typed right after it.
          if (f === "br") walk(c)
          else if (f === "b" || f === "i") out.push({ tag: f, children: tokensOf(c) })
          else if (f === "a")
            out.push({ tag: "a", href: c.getAttribute(HREF_ATTR) ?? "", children: tokensOf(c) })
          else walk(c)
        } else if (c.localName === "br") out.push({ tag: "br" })
        else if (/^(?:b|strong|i|em)$/.test(c.localName))
          out.push({ tag: c.localName as SourceInlineTag, children: tokensOf(c) })
        else if (/^(?:script|style|template|noscript|title|meta|link)$/.test(c.localName)) continue
        else {
          // Invented by the browser: its words stay, its markup doesn't. A block it
          // opened (Enter, a paste) sits on its own line.
          const block = BLOCKISH.test(c.localName)
          if (block) lineBreak()
          walk(c)
          if (block && c.nextSibling) lineBreak()
        }
      }
    }
    walk(el)
    return out
  }
  const ops: SourceOp[] = []
  const visit = (el: Element) => {
    if (changed.has(el)) {
      const src = srcOf(el) as number
      if (snap.dupes.has(src)) ok = false
      ops.push({ op: "content", src, hash: "", children: tokensOf(el) })
      return
    }
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (dirty.has(c)) visit(c)
  }
  visit(root)
  return { ops, ok }
}

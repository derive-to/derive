/**
 * A BibTeX reader and two reference formatters, for citations in LaTeX artifacts.
 *
 * `parseBibtex` reads the `.bib` grammar BibTeX itself accepts: `@type{key, field = ...}`
 * with brace, quote or bare values, `@string` macros with `#` concatenation, `@comment`
 * and `@preamble`. Field values keep their braces so a formatter can honour case
 * protection; `latexToText` (latex-chars.ts) turns them into characters at the end.
 *
 * The formatters approximate the two styles the paper templates ship with:
 * ACM-Reference-Format for acmart and ieeenat_fullname (the CVPR author kit) for cvpr,
 * with `plain` as the fallback. They are readings for the web page; the source zip
 * compiles the real `.bst`, which stays the authority on the typeset list.
 */

import { latexToText } from "./latex-chars"

export interface BibEntry {
  type: string
  key: string
  fields: Record<string, string>
  line: number
  /** Where the entry sits in the file: the `@`, and the offset after its closing bracket. */
  start: number
  end: number
  /** The entry's own text, `@type{key, ...}` verbatim, so it can be edited as a unit. */
  raw: string
}

export interface BibDiagnostic {
  code: string
  message: string
  line: number
}

export interface ParsedBibtex {
  entries: BibEntry[]
  strings: Record<string, string>
  preambles: string[]
  diagnostics: BibDiagnostic[]
  /** Keys that appear more than once; only the first occurrence is in `entries`. */
  duplicates: string[]
}

export interface ParseBibtexOptions {
  /** `@string` macros already defined elsewhere (another file, or the file an entry is
   *  being added to), by lower-cased name. */
  strings?: Record<string, string>
}

const MONTHS: Record<string, string> = {
  jan: "January",
  feb: "February",
  mar: "March",
  apr: "April",
  may: "May",
  jun: "June",
  jul: "July",
  aug: "August",
  sep: "September",
  oct: "October",
  nov: "November",
  dec: "December",
}

const NAME_TOKEN = /^[A-Za-z0-9_:.+/-]+/

/** Parse a `.bib` file. Never throws; a malformed entry becomes a diagnostic and the
 *  reader resumes at the next `@`. */
export const parseBibtex = (source: string, opts: ParseBibtexOptions = {}): ParsedBibtex => {
  const s = source
  const entries: BibEntry[] = []
  const strings: Record<string, string> = { ...opts.strings }
  const preambles: string[] = []
  const diagnostics: BibDiagnostic[] = []
  const duplicates: string[] = []
  const seen = new Set<string>()
  let pos = 0
  const lineAt = (at: number) => {
    let line = 1
    for (let i = 0; i < at && i < s.length; i++) if (s.charCodeAt(i) === 10) line++
    return line
  }
  const diag = (code: string, message: string, at: number) => {
    if (diagnostics.length < 64) diagnostics.push({ code, message, line: lineAt(at) })
  }
  const skipWs = () => {
    while (pos < s.length) {
      const ch = s[pos]
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") pos++
      else break
    }
  }
  const readBraced = (): string | null => {
    if (s[pos] !== "{") return null
    let level = 0
    const start = pos
    for (; pos < s.length; pos++) {
      const ch = s[pos]
      if (ch === "\\") {
        pos++
        continue
      }
      if (ch === "{") level++
      else if (ch === "}") {
        level--
        if (level === 0) {
          pos++
          return s.slice(start + 1, pos - 1)
        }
      }
    }
    pos = start
    return null
  }
  const readQuoted = (): string | null => {
    if (s[pos] !== '"') return null
    const start = pos
    let level = 0
    pos++
    for (; pos < s.length; pos++) {
      const ch = s[pos]
      if (ch === "\\") {
        pos++
        continue
      }
      if (ch === "{") level++
      else if (ch === "}") level--
      else if (ch === '"' && level === 0) {
        pos++
        return s.slice(start + 1, pos - 1)
      }
    }
    pos = start
    return null
  }
  /** One value: pieces joined by `#`, each a braced/quoted string, a number, or a macro. */
  const readValue = (at: number): string | null => {
    let out = ""
    for (;;) {
      skipWs()
      const braced = readBraced()
      if (braced !== null) out += braced
      else {
        const quoted = readQuoted()
        if (quoted !== null) out += quoted
        else {
          const m = NAME_TOKEN.exec(s.slice(pos))
          if (!m) return null
          pos += m[0].length
          const name = m[0]
          const lower = name.toLowerCase()
          if (/^\d+$/.test(name)) out += name
          else if (strings[lower] !== undefined) out += strings[lower]
          else if (MONTHS[lower] !== undefined) out += MONTHS[lower]
          else {
            diag("unknown-string", `@string ${name} is not defined`, at)
            out += name
          }
        }
      }
      skipWs()
      if (s[pos] === "#") {
        pos++
        continue
      }
      return out
    }
  }
  while (pos < s.length) {
    const at = s.indexOf("@", pos)
    if (at === -1) break
    pos = at + 1
    const typeMatch = /^[A-Za-z]+/.exec(s.slice(pos))
    if (!typeMatch) continue
    const type = typeMatch[0].toLowerCase()
    pos += type.length
    skipWs()
    const open = s[pos]
    if (open !== "{" && open !== "(") {
      diag("malformed-entry", `@${type} is not followed by { or (`, at)
      continue
    }
    const close = open === "{" ? "}" : ")"
    const entryStart = pos
    pos++
    if (type === "comment") {
      pos = entryStart
      if (readBraced() === null) pos = s.length
      continue
    }
    if (type === "preamble") {
      const v = readValue(at)
      if (v !== null) preambles.push(v)
      skipWs()
      if (s[pos] === close) pos++
      continue
    }
    if (type === "string") {
      skipWs()
      const nm = NAME_TOKEN.exec(s.slice(pos))
      if (!nm) {
        diag("malformed-string", "@string without a name", at)
        continue
      }
      pos += nm[0].length
      skipWs()
      if (s[pos] !== "=") {
        diag("malformed-string", `@string ${nm[0]} has no value`, at)
        continue
      }
      pos++
      const v = readValue(at)
      if (v !== null) strings[nm[0].toLowerCase()] = v
      skipWs()
      if (s[pos] === close) pos++
      continue
    }
    skipWs()
    const keyMatch = /^[^,\s{}()"=]+/.exec(s.slice(pos))
    if (!keyMatch) {
      diag("missing-key", `@${type} has no citation key`, at)
      continue
    }
    const key = keyMatch[0]
    pos += key.length
    const fields: Record<string, string> = {}
    let ok = true
    for (;;) {
      skipWs()
      if (s[pos] === ",") {
        pos++
        skipWs()
      }
      if (s[pos] === close) {
        pos++
        break
      }
      const fm = NAME_TOKEN.exec(s.slice(pos))
      if (!fm) {
        diag("malformed-field", `${key}: expected a field name`, pos)
        ok = false
        break
      }
      const field = fm[0].toLowerCase()
      pos += fm[0].length
      skipWs()
      if (s[pos] !== "=") {
        diag("malformed-field", `${key}: field ${field} has no value`, pos)
        ok = false
        break
      }
      pos++
      const v = readValue(pos)
      if (v === null) {
        diag("malformed-field", `${key}: field ${field} has no readable value`, pos)
        ok = false
        break
      }
      fields[field] = v.replace(/\s+/g, " ").trim()
    }
    if (!ok) {
      // Resume at the next entry rather than guessing where this one ends.
      const next = s.indexOf("\n@", pos)
      pos = next === -1 ? s.length : next + 1
      if (Object.keys(fields).length === 0) continue
    }
    if (seen.has(key)) {
      diag("duplicate-key", `citation key ${key} appears more than once`, at)
      if (!duplicates.includes(key)) duplicates.push(key)
      continue
    }
    seen.add(key)
    // A broken entry ends where the reader resumed; trim the whitespace before the next `@`.
    let end = pos
    if (!ok) while (end > at && /\s/.test(s[end - 1] as string)) end--
    entries.push({ type, key, fields, line: lineAt(at), start: at, end, raw: s.slice(at, end) })
  }
  return { entries, strings, preambles, diagnostics, duplicates }
}

/** One change to a `.bib` file. `set` writes a complete entry (`@type{key, ...}`): over
 *  the entry named by `key` (a rename when the text carries another key), else over the
 *  entry with the text's own key, else appended at the end. `delete` removes an entry. */
export type BibOp = { op: "set"; key?: string; raw: string } | { op: "delete"; key: string }

/** A refused `spliceBibtex`. The message is written for the person who typed the entry. */
export class BibtexError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BibtexError"
  }
}

const KEY_GRAMMAR = /^[A-Za-z0-9_:.+/-]+$/

/** One entry typed or pasted by hand: exactly `@type{key, ...}` and nothing else, read
 *  with the file's `@string` macros so bare values keep resolving. */
const parseOneEntry = (raw: string, strings: Record<string, string>): BibEntry => {
  const text = typeof raw === "string" ? raw.trim() : ""
  if (!text.startsWith("@")) throw new BibtexError("An entry starts with @type{key, ...}.")
  const parsed = parseBibtex(text, { strings })
  const d = parsed.diagnostics[0]
  if (d) throw new BibtexError(`The entry could not be read: ${d.message} (line ${d.line}).`)
  const entry = parsed.entries[0]
  if (!entry) throw new BibtexError("The entry needs the shape @type{key, field = {value}}.")
  if (parsed.entries.length > 1) throw new BibtexError("Save one entry at a time.")
  if (entry.start !== 0 || entry.end !== text.length)
    throw new BibtexError(
      "Only the entry itself can be saved here; comments and @string lines belong in the source editor.",
    )
  if (!KEY_GRAMMAR.test(entry.key))
    throw new BibtexError(
      `The citation key ${entry.key} may only use letters, digits and _ : . + / -.`,
    )
  return entry
}

/** Apply `ops` to a `.bib` file by splicing entry spans, so comments, `@string` macros
 *  and the spacing around untouched entries survive byte for byte. Throws `BibtexError`
 *  and changes nothing when an op cannot be honoured. */
export const spliceBibtex = (
  source: string,
  ops: BibOp[],
): { source: string; entries: BibEntry[] } => {
  if (!ops.length) throw new BibtexError("Nothing to change.")
  const parsed = parseBibtex(source)
  const byKey = new Map(parsed.entries.map((e) => [e.key, e]))
  const touched = new Set<string>()
  const claim = (key: string) => {
    if (parsed.duplicates.includes(key))
      throw new BibtexError(
        `The key ${key} appears more than once in the file; fix that in the source editor first.`,
      )
    if (touched.has(key)) throw new BibtexError(`The key ${key} is changed twice in one save.`)
    touched.add(key)
  }
  const edits: { start: number; end: number; text: string }[] = []
  const appended: string[] = []
  for (const op of ops) {
    if (op.op === "delete") {
      const target = byKey.get(op.key)
      if (!target) throw new BibtexError(`There is no entry with the key ${op.key}.`)
      claim(op.key)
      // Take the blank line after it too, so the neighbours stay one blank line apart.
      let end = target.end
      let newlines = 0
      while (end < source.length && newlines < 2 && /[ \t\r\n]/.test(source[end] as string)) {
        if (source[end] === "\n") newlines++
        end++
      }
      edits.push({ start: target.start, end, text: "" })
      continue
    }
    const entry = parseOneEntry(op.raw, parsed.strings)
    const targetKey = op.key ?? entry.key
    const target = byKey.get(targetKey)
    if (op.key !== undefined && !target)
      throw new BibtexError(`There is no entry with the key ${op.key}.`)
    if (target) claim(targetKey)
    if (!target || entry.key !== targetKey) {
      if (byKey.has(entry.key))
        throw new BibtexError(`The key ${entry.key} is already used by another entry.`)
      claim(entry.key)
    }
    if (target) edits.push({ start: target.start, end: target.end, text: entry.raw })
    else appended.push(entry.raw)
  }
  edits.sort((a, b) => b.start - a.start)
  let out = source
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  if (appended.length) {
    const body = out.replace(/\s+$/, "")
    out = `${body}${body ? "\n\n" : ""}${appended.join("\n\n")}\n`
  }
  return { source: out, entries: parseBibtex(out).entries }
}

export interface BibAuthor {
  first: string
  von: string
  last: string
  jr: string
  /** `and others` in the source. */
  others: boolean
}

/** Split on `sep` matches that sit outside braces. */
const splitTopLevel = (value: string, sep: RegExp): string[] => {
  const parts: string[] = []
  let level = 0
  let cur = ""
  let i = 0
  while (i < value.length) {
    const ch = value[i] as string
    if (ch === "{") level++
    else if (ch === "}") level--
    if (level === 0) {
      const m = sep.exec(value.slice(i))
      if (m && m.index === 0) {
        parts.push(cur)
        cur = ""
        i += m[0].length
        continue
      }
    }
    cur += ch
    i++
  }
  parts.push(cur)
  return parts
}

const startsLower = (word: string): boolean => {
  const c = latexToText(word)[0]
  return c !== undefined && c.toLowerCase() === c && c.toUpperCase() !== c
}

/** Split an `author`/`editor` field by BibTeX's rules: `First von Last`, `von Last,
 *  First`, `von Last, Jr, First`, braces group a corporate name, `others` is "et al.". */
export const parseAuthors = (field: string): BibAuthor[] => {
  const names = splitTopLevel(field.trim(), /^\s+and\s+/i).filter((n) => n.trim())
  return names.map((raw): BibAuthor => {
    const name = raw.trim()
    if (name.toLowerCase() === "others")
      return { first: "", von: "", last: "", jr: "", others: true }
    const commas = splitTopLevel(name, /^\s*,\s*/).map((p) => p.trim())
    const words = (part: string) => splitTopLevel(part, /^\s+/).filter(Boolean)
    if (commas.length >= 2) {
      const vonLast = words(commas[0] as string)
      const jr = commas.length >= 3 ? (commas[1] as string) : ""
      const first = (commas.length >= 3 ? commas[2] : commas[1]) ?? ""
      let split = 0
      while (split < vonLast.length - 1 && startsLower(vonLast[split] as string)) split++
      return {
        first: latexToText(first),
        von: latexToText(vonLast.slice(0, split).join(" ")),
        last: latexToText(vonLast.slice(split).join(" ")),
        jr: latexToText(jr),
        others: false,
      }
    }
    const ws = words(name)
    if (ws.length === 1)
      return { first: "", von: "", last: latexToText(ws[0] as string), jr: "", others: false }
    // First von Last: the von part runs from the first lowercase word to the last one
    // before the final word.
    let vonStart = -1
    let vonEnd = -1
    for (let i = 0; i < ws.length - 1; i++) {
      if (startsLower(ws[i] as string)) {
        if (vonStart === -1) vonStart = i
        vonEnd = i
      }
    }
    if (vonStart === -1) {
      return {
        first: latexToText(ws.slice(0, -1).join(" ")),
        von: "",
        last: latexToText(ws[ws.length - 1] as string),
        jr: "",
        others: false,
      }
    }
    return {
      first: latexToText(ws.slice(0, vonStart).join(" ")),
      von: latexToText(ws.slice(vonStart, vonEnd + 1).join(" ")),
      last: latexToText(ws.slice(vonEnd + 1).join(" ")),
      jr: "",
      others: false,
    }
  })
}

/** `First von Last, Jr` for a reference list (both target styles print full names). */
export const authorDisplayName = (a: BibAuthor): string => {
  if (a.others) return "et al."
  const parts = [a.first, a.von, a.last].filter(Boolean).join(" ")
  return a.jr ? `${parts}, ${a.jr}` : parts
}

/** The surname used for sorting and author-year labels. */
export const authorSortName = (a: BibAuthor): string =>
  [a.von, a.last].filter(Boolean).join(" ").toLowerCase()

/** "A", "A and B", "A, B, and C" (both styles use the serial comma); `others` becomes
 *  "et al." after the names before it. */
export const authorListText = (authors: BibAuthor[]): string => {
  const names = authors.map(authorDisplayName)
  if (names.length === 0) return ""
  if (names.length === 1) return names[0] as string
  const last = names[names.length - 1] as string
  if (last === "et al.") return `${names.slice(0, -1).join(", ")} et al.`
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(", ")}, and ${last}`
}

export type BibStyle = "acm" | "ieeenat" | "plain"

export interface ReferencePart {
  text: string
  italic?: boolean
  href?: string
}

const pagesOf = (p: string | undefined): string =>
  p ? latexToText(p).replace(/\s*[-–]{1,3}\s*/g, "–") : ""

const yearOf = (e: BibEntry): string => latexToText(e.fields.year ?? "") || "n.d."

const linkOf = (e: BibEntry): string | null => {
  const doi = e.fields.doi ? latexToText(e.fields.doi) : ""
  if (doi) {
    return /^https?:\/\//i.test(doi) ? doi : `https://doi.org/${doi.replace(/^doi:\s*/i, "")}`
  }
  const url = e.fields.url ? latexToText(e.fields.url) : ""
  return /^https?:\/\//i.test(url) ? url : null
}

const authorsOf = (e: BibEntry): BibAuthor[] =>
  parseAuthors(e.fields.author ?? e.fields.editor ?? "")

const PROCEEDINGS = new Set(["inproceedings", "incollection", "conference"])
const BOOKS = new Set(["book", "phdthesis", "mastersthesis"])

/** The reference entry as text runs, in the style's order. */
export const referenceParts = (e: BibEntry, style: BibStyle): ReferencePart[] => {
  const f = e.fields
  const authors = authorListText(authorsOf(e)) || "Anonymous"
  const title = latexToText(f.title ?? "")
  const year = yearOf(e)
  const out: ReferencePart[] = []
  const push = (text: string, italic = false) => {
    if (text) out.push(italic ? { text, italic } : { text })
  }
  const link = linkOf(e)
  const journal = latexToText(f.journal ?? "")
  const booktitle = latexToText(f.booktitle ?? "")
  const publisher = latexToText(f.publisher ?? f.school ?? f.institution ?? "")
  const volume = latexToText(f.volume ?? "")
  const number = latexToText(f.number ?? "")
  const pages = pagesOf(f.pages)
  const note = latexToText(f.note ?? f.howpublished ?? "")
  const isBook = BOOKS.has(e.type)
  if (style === "acm") {
    // ACM-Reference-Format: Authors. Year. Title. Venue detail. DOI or URL.
    push(`${authors}. ${year}. `)
    push(isBook ? title : `${title}.`, isBook)
    push(isBook ? ". " : " ")
    if (e.type === "article") {
      push(journal, true)
      const vn = volume ? `${volume}${number ? `, ${number}` : ""}` : ""
      push(
        `${journal && vn ? " " : ""}${vn}${vn ? ` (${year})` : ""}${pages ? `, ${pages}` : ""}. `,
      )
    } else if (PROCEEDINGS.has(e.type)) {
      push("In ")
      push(booktitle, true)
      const tail = [publisher, pages].filter(Boolean).join(", ")
      push(`${booktitle ? ". " : ""}${tail}${tail ? ". " : ""}`)
    } else if (e.type === "phdthesis")
      push(`Ph.D. Dissertation. ${publisher}${publisher ? ". " : ""}`)
    else if (e.type === "mastersthesis")
      push(`Master's thesis. ${publisher}${publisher ? ". " : ""}`)
    else if (isBook) push(`${publisher}${publisher ? ". " : ""}`)
    else push(`${note}${note ? ". " : ""}`)
    if (link) out.push({ text: link, href: link })
    return out
  }
  // ieeenat_fullname and plain: Authors. Title. In Venue, pages, Year.
  push(`${authors}. `)
  push(isBook ? title : `${title}.`, isBook)
  push(isBook ? ". " : " ")
  if (e.type === "article") {
    push(journal, true)
    const vn = volume ? `${volume}${number ? `(${number})` : ""}` : ""
    const detail = `${vn}${vn && pages ? ":" : ""}${pages}`
    push(`${journal ? ", " : ""}${detail}${detail ? ", " : ""}${year}.`)
  } else if (PROCEEDINGS.has(e.type)) {
    push("In ")
    push(booktitle, true)
    push(`${booktitle ? ", " : ""}${pages ? `pages ${pages}, ` : ""}${year}.`)
  } else if (e.type === "phdthesis")
    push(`PhD thesis, ${publisher}${publisher ? ", " : ""}${year}.`)
  else if (isBook) push(`${publisher}${publisher ? ", " : ""}${year}.`)
  else push(`${note}${note ? ", " : ""}${year}.`)
  if (link && !f.doi) out.push({ text: ` ${link}`, href: link })
  return out
}

/** The author-year label parts: `Trovato and Tobin`, `Smith et al.`, and the year. */
export const authorYearLabel = (e: BibEntry): { authors: string; year: string } => {
  const names = authorsOf(e).map((a) => (a.others ? "et al." : a.last || a.first))
  let text: string
  if (names.length === 0) text = latexToText(e.fields.key ?? e.key)
  else if (names.length === 1) text = names[0] as string
  else if (names.length === 2)
    text = names[1] === "et al." ? `${names[0]} et al.` : `${names[0]} and ${names[1]}`
  else text = `${names[0]} et al.`
  return { authors: text, year: yearOf(e) }
}

const referenceSortKey = (e: BibEntry): string => {
  const names = authorsOf(e).map((a) =>
    a.others ? "zzz" : `${authorSortName(a)} ${a.first.toLowerCase()}`,
  )
  const head = names.length
    ? names.join("  ")
    : latexToText(e.fields.key ?? e.fields.title ?? e.key).toLowerCase()
  return `${head} ${yearOf(e)} ${latexToText(e.fields.title ?? "").toLowerCase()}`
}

/** Alphabetical by first author, then year, then title: the order all three styles
 *  produce (each sorts; none keeps citation order). */
export const sortBibEntries = (entries: BibEntry[]): BibEntry[] =>
  [...entries].sort((a, b) => {
    const ka = referenceSortKey(a)
    const kb = referenceSortKey(b)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })

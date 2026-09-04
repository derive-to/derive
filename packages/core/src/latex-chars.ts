/**
 * The character-level half of reading LaTeX: accents, text symbols and ligatures. Shared
 * by the BibTeX reader (field values are LaTeX) and the HTML renderer, so a name spelled
 * `Fran\c{c}ois` looks the same in a citation and in a byline. Leaf module: no imports.
 */

/** Accent macros mapped to their Unicode combining mark; `base + mark` then NFC gives the
 *  precomposed letter when one exists (ö, ş, ő) and a correct decomposed one otherwise. */
export const ACCENT_MARKS: Record<string, string> = {
  "'": "́",
  "`": "̀",
  "^": "̂",
  '"': "̈",
  "~": "̃",
  "=": "̄",
  ".": "̇",
  c: "̧",
  v: "̌",
  u: "̆",
  H: "̋",
  k: "̨",
  r: "̊",
  b: "̱",
  d: "̣",
  t: "͡",
}

export const accentChar = (mark: string, base: string): string | null => {
  const combining = ACCENT_MARKS[mark]
  if (combining === undefined) return null
  // `\'{\i}` is how TeX spells í: the dotless i exists so the accent replaces the dot.
  // Unicode composes the accent onto the dotted letter, so map the dotless forms back.
  const letter = base === "\\i" || base === "ı" ? "i" : base === "\\j" || base === "ȷ" ? "j" : base
  if (letter.length === 0) return combining
  return (letter + combining).normalize("NFC")
}

/** Argument-less text macros and control symbols with a fixed Unicode reading. */
export const TEXT_SYMBOLS: Record<string, string> = {
  ss: "ß",
  ae: "æ",
  AE: "Æ",
  oe: "œ",
  OE: "Œ",
  o: "ø",
  O: "Ø",
  aa: "å",
  AA: "Å",
  l: "ł",
  L: "Ł",
  i: "ı",
  j: "ȷ",
  S: "§",
  P: "¶",
  dag: "†",
  ddag: "‡",
  copyright: "©",
  textregistered: "®",
  texttrademark: "™",
  textdegree: "°",
  textbullet: "•",
  textquoteleft: "‘",
  textquoteright: "’",
  textquotedblleft: "“",
  textquotedblright: "”",
  textendash: "–",
  textemdash: "—",
  textbackslash: "\\",
  textasciitilde: "~",
  textasciicircum: "^",
  textbar: "|",
  textless: "<",
  textgreater: ">",
  textunderscore: "_",
  textvisiblespace: "␣",
  textperiodcentered: "·",
  textapprox: "≈",
  textellipsis: "…",
  ldots: "…",
  dots: "…",
  euro: "€",
  pounds: "£",
  checkmark: "✓",
  LaTeX: "LaTeX",
  TeX: "TeX",
  quad: " ",
  qquad: "  ",
  enspace: " ",
  thinspace: " ",
  negthinspace: "",
  slash: "/",
  "-": "",
  "/": "",
  " ": " ",
  ",": " ",
  ";": " ",
  "!": "",
  ":": " ",
  "@": "",
  "%": "%",
  "&": "&",
  "#": "#",
  $: "$",
  _: "_",
  "{": "{",
  "}": "}",
  "~": " ",
}

/** Ligatures TeX makes from ordinary characters, longest first. */
export const LIGATURES: [string, string][] = [
  ["---", "—"],
  ["--", "–"],
  ["``", "“"],
  ["''", "”"],
  ["`", "‘"],
  ["'", "’"],
  ["~", " "],
]

/**
 * A light conversion of LaTeX-flavoured text (a BibTeX field, a title) to plain text:
 * accents and symbol macros become characters, formatting macros keep their argument,
 * braces vanish, ligatures resolve, and anything unknown keeps its argument text so a
 * reference never loses words. Not a renderer: math stays as its TeX.
 */
export const latexToText = (input: string): string => {
  let out = ""
  let i = 0
  const s = input
  const readGroup = (): string | null => {
    if (s[i] !== "{") return null
    let level = 0
    const start = i
    for (; i < s.length; i++) {
      if (s[i] === "\\") {
        i++
        continue
      }
      if (s[i] === "{") level++
      else if (s[i] === "}") {
        level--
        if (level === 0) {
          i++
          return s.slice(start + 1, i - 1)
        }
      }
    }
    i = s.length
    return s.slice(start + 1)
  }
  while (i < s.length) {
    const ch = s[i] as string
    if (ch === "\\") {
      i++
      const rest = s.slice(i)
      const word = /^[A-Za-z]+/.exec(rest)
      if (word) {
        const name = word[0]
        i += name.length
        if (ACCENT_MARKS[name] !== undefined && name.length === 1) {
          while (s[i] === " ") i++
          const arg = readGroup() ?? (s[i] !== undefined ? s[i++] : "")
          const inner = latexToText(arg ?? "")
          out += accentChar(name, inner) ?? inner
          continue
        }
        if (TEXT_SYMBOLS[name] !== undefined) {
          out += TEXT_SYMBOLS[name]
          // TeX swallows the space after a control word; `\LaTeX\ rocks` keeps it via `\ `.
          while (s[i] === " ") i++
          continue
        }
        // A formatting or unknown macro: keep the argument's text, drop the wrapper.
        while (s[i] === " ") i++
        continue
      }
      const sym = s[i]
      if (sym === undefined) break
      i++
      if (ACCENT_MARKS[sym] !== undefined) {
        const arg = readGroup() ?? (s[i] !== undefined ? s[i++] : "")
        const inner = latexToText(arg ?? "")
        out += accentChar(sym, inner) ?? inner
        continue
      }
      if (sym === "\n") {
        out += " "
        continue
      }
      out += TEXT_SYMBOLS[sym] ?? sym
      continue
    }
    if (ch === "{") {
      const g = readGroup()
      out += latexToText(g ?? "")
      continue
    }
    if (ch === "}") {
      i++
      continue
    }
    if (ch === "$") {
      // Inline math inside a title: keep the TeX between the dollars as-is.
      const close = s.indexOf("$", i + 1)
      if (close === -1) {
        out += s.slice(i + 1)
        break
      }
      out += s.slice(i + 1, close)
      i = close + 1
      continue
    }
    let lig = false
    for (const [tex, uni] of LIGATURES) {
      if (s.startsWith(tex, i)) {
        out += uni
        i += tex.length
        lig = true
        break
      }
    }
    if (lig) continue
    out += ch
    i++
  }
  return out.replace(/[ \t\r\n]+/g, " ").trim()
}

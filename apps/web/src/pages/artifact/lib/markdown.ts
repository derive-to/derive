import type { Mention } from "@/api"
import { emojifyShortcodes } from "@/lib/emoji"

// Tiny, XSS-safe inline markdown: escape first, then a few transforms. Covers
// bold, italic, inline code, links/autolinks, @mentions, and line breaks.
const esc = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string,
  )
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export function mdToHtml(src: string, mentions?: Mention[]): string {
  // Escape first (XSS), then turn :shortcodes: into emoji — the inserted chars
  // are safe and don't interfere with the mention/markdown passes below.
  let h = emojifyShortcodes(esc(src))
  // Highlight @mentions from the comment's known set (longest name first so a
  // fuller name wins over a prefix). Names are escaped to match the escaped body.
  if (mentions?.length) {
    const names = [...new Set(mentions.map((m) => m.name))]
      .sort((a, b) => b.length - a.length)
      .map((n) => escRe(esc(n)))
    if (names.length)
      h = h.replace(new RegExp(`@(${names.join("|")})`, "g"), '<span class="mention">@$1</span>')
  }
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>")
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  h = h.replace(/~~([^~]+)~~/g, "<del>$1</del>")
  h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
  h = h.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  )
  // ROOT-RELATIVE links — `[Q3 Roadmap](/artifacts/ab12cd34)`. An agent cites a document by its
  // PATH (it has no business knowing this deploy's hostname), and without this the citation
  // rendered as literal bracket-paren text: the one thing an answer about a document most needs
  // to carry, dropped on the floor.
  //
  // The pattern is what makes it safe, so keep it strict: a leading slash followed by an
  // ALPHANUMERIC. That admits `/artifacts/x` and excludes both `javascript:` (no leading slash)
  // and `//evil.com` (protocol-relative, the classic bypass — blocked by the second character).
  // No target=_blank: these stay in the app, and the chat surface routes them client-side.
  h = h.replace(/\[([^\]]+)\]\((\/[A-Za-z0-9][\w\-./?=&#%]*)\)/g, '<a href="$2">$1</a>')
  h = h.replace(
    /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>',
  )
  return h.replace(/\n/g, "<br/>")
}

/** Safe report markdown. Block structure is emitted here; all prose still goes through the
 * shared escaped inline renderer. Fenced code bypasses inline formatting entirely. */
export function mdBlocksToHtml(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n")
  const out: string[] = []
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\||\|$/g, "")
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, "|"))
  const tableRule = (line: string) =>
    line.includes("|") && cells(line).every((c) => /^:?-{3,}:?$/.test(c))
  const listItem = (line: string) => /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line)
  for (let i = 0; i < lines.length; ) {
    const line = lines[i] ?? ""
    if (!line.trim()) {
      i++
      continue
    }
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      const marker = fence[1] ?? "```"
      const code: string[] = []
      i++
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith(marker))
        code.push(lines[i++] ?? "")
      i++
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`)
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = Math.min(heading[1]?.length ?? 2, 4)
      out.push(`<h${level}>${mdToHtml(heading[2] ?? "")}</h${level}>`)
      i++
      continue
    }
    if (line.includes("|") && tableRule(lines[i + 1] ?? "")) {
      const header = cells(line)
      i += 2
      const rows: string[] = []
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim()) {
        const row = cells(lines[i++] ?? "")
        rows.push(`<tr>${header.map((_, n) => `<td>${mdToHtml(row[n] ?? "")}</td>`).join("")}</tr>`)
      }
      out.push(
        `<div class="markdown-table"><table><thead><tr>${header.map((c) => `<th scope="col">${mdToHtml(c)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`,
      )
      continue
    }
    const item = listItem(line)
    if (item) {
      const ordered = /^\d/.test(item[1] ?? "")
      const tag = ordered ? "ol" : "ul"
      const items: string[] = []
      while (i < lines.length) {
        const next = listItem(lines[i] ?? "")
        if (!next || /^\d/.test(next[1] ?? "") !== ordered) break
        items.push(`<li>${mdToHtml(next[2] ?? "")}</li>`)
        i++
      }
      out.push(`<${tag}>${items.join("")}</${tag}>`)
      continue
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i] ?? ""))
        quote.push((lines[i++] ?? "").replace(/^>\s?/, ""))
      out.push(`<blockquote>${mdBlocksToHtml(quote.join("\n"))}</blockquote>`)
      continue
    }
    const paragraph = [line]
    i++
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() &&
      !/^(#{1,6}\s|\s*```|\s*~~~|>)/.test(lines[i] ?? "") &&
      !listItem(lines[i] ?? "") &&
      !tableRule(lines[i + 1] ?? "")
    )
      paragraph.push(lines[i++] ?? "")
    out.push(`<p>${mdToHtml(paragraph.join("\n"))}</p>`)
  }
  return out.join("")
}

import type { Mention } from "@/api"

// Tiny, XSS-safe inline markdown: escape first, then a few transforms. Covers
// bold, italic, inline code, links/autolinks, @mentions, and line breaks.
const esc = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string,
  )
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export function mdToHtml(src: string, mentions?: Mention[]): string {
  let h = esc(src)
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
  h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
  h = h.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  )
  h = h.replace(
    /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>',
  )
  return h.replace(/\n/g, "<br/>")
}

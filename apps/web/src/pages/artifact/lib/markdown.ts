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

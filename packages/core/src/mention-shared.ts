/**
 * Isomorphic @mention primitives. The document iframe and the publish-time server
 * both operate on untrusted text, so the handle grammar and its email / URL
 * boundaries live here rather than in two hand-maintained regexes.
 *
 * Keep this module dependency-free and DOM-free: anchor-client bundles it into the
 * sandboxed iframe, while the API imports the same functions through @derive/core.
 */

/** Account handles are 2–30 ASCII characters, with single interior - / _ separators. */
export const MENTION_HANDLE_RE = /^[a-z0-9](?:[a-z0-9]|[-_](?=[a-z0-9])){1,29}$/i
export const MENTION_QUERY_RE = /^[a-z0-9_-]{0,30}$/i

/** HTML elements whose text is source, metadata, or a control label — never document prose. */
export const MENTION_NON_PROSE_TAGS = [
  "script",
  "style",
  "noscript",
  "template",
  "head",
  "title",
  "code",
  "pre",
  "textarea",
  "input",
  "button",
  "select",
  "option",
] as const

export const MENTION_NON_PROSE_SELECTOR = MENTION_NON_PROSE_TAGS.join(",")

/** A concrete syntactic mention in plain text, including its exact text offsets. */
export type MentionToken = { handle: string; start: number; end: number }

/** True only for the canonical persisted handle shape (not an incomplete picker query). */
export const isMentionHandle = (value: unknown): value is string =>
  typeof value === "string" && MENTION_HANDLE_RE.test(value)

/** Guard untrusted picker messages before they are handed to the authenticated directory. */
export const isMentionQuery = (value: unknown): value is string =>
  typeof value === "string" && MENTION_QUERY_RE.test(value)

/**
 * Find syntactic @mentions in document prose. The negative boundaries keep email
 * addresses, routes, and longer identifiers out; the leading boundary is included
 * in the regexp so a global scan cannot start midway through one of those tokens.
 */
export const mentionTokens = (text: string): MentionToken[] => {
  const re =
    /(^|[^a-z0-9._@-])@([a-z0-9](?:[a-z0-9]|[-_](?=[a-z0-9])){1,29})(?![a-z0-9_-]|\.[a-z0-9])/gi
  const tokens: MentionToken[] = []
  for (const match of text.matchAll(re)) {
    const boundary = match[1] ?? ""
    const handle = match[2]
    if (!handle) continue
    const start = match.index + boundary.length
    // The grammar cannot tell a prose slash from a URL-path slash by looking one
    // character left. Inspect the surrounding whitespace-delimited token instead,
    // so `https://derive.test/users/@ada` stays a route in BOTH the reader and the
    // publish-time parser rather than becoming a phantom teammate.
    const before = text.slice(0, start)
    const after = text.slice(start)
    const tokenStart = before.length - (before.match(/\S*$/)?.[0].length ?? 0)
    const nextWhitespace = after.search(/\s/)
    const tokenEnd = nextWhitespace < 0 ? text.length : start + nextWhitespace
    const surroundingToken = text.slice(tokenStart, tokenEnd).replace(/^[([<{"']+/, "")
    if (/^(?:https?:\/\/|mailto:|www\.)/i.test(surroundingToken)) continue
    tokens.push({ handle, start, end: start + handle.length + 1 })
  }
  return tokens
}

/**
 * The incomplete mention at a caret's left edge, if any. This deliberately permits
 * an unfinished query (`@ali-`) so the picker can repair it with a canonical handle;
 * insertion still requires {@link isMentionHandle}.
 */
export const mentionQueryAtEnd = (
  text: string,
): { query: string; start: number; end: number } | null => {
  const match = /(^|[^a-z0-9._@-])@([a-z0-9_-]{0,30})$/i.exec(text)
  if (!match) return null
  const boundary = match[1] ?? ""
  const query = match[2] ?? ""
  const start = text.length - match[0].length + boundary.length
  return { query, start, end: text.length }
}

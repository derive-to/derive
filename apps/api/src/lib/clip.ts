// Bounds a text response so no single read/search result can blow a client's
// context budget (an MCP tool response, or an HTTP client fetching the same data).
// Claude caps tool responses at ~25k tokens; ~80k chars is a safe ceiling under that.
export const MAX_CHARS = 80_000

export const clip = (s: string): string =>
  s.length > MAX_CHARS
    ? `${s.slice(0, MAX_CHARS)}\n\n…[truncated ${s.length - MAX_CHARS} chars — narrow the range]`
    : s

// Pure, request-independent helpers and constants shared across the MCP server build
// (mcp.ts), the per-request tool context (mcp-tool-context.ts), and every per-tool
// module (mcp-tools/*). Everything here is stateless — response shapers
// (text/json/err/doc), size/format helpers, record summarizers, base64, and their
// constants — so nothing closes over request identity. That is why it can be imported by
// both mcp.ts and the tool files with no import cycle.

import {
  type ArtifactRecord,
  type BundleManifest,
  type ContextRecord,
  isHtmlLike,
  type OutlineSection,
  SKILL_CONTENT_TYPE,
  type VersionRecord,
} from "@derive/core"
import { z } from "zod"
import type { AppContext } from "./context"
import { cleanPath, manifestOf as sharedManifestOf } from "./lib/bundle"
import { MAX_CHARS } from "./lib/clip"
import { quoteOf } from "./lib/comments"
import { baseType, type ReadFormat } from "./lib/search"

export const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] })
// Bound a best-effort promise (the tab-delivery receipt) so it can never stall a
// publish: past `ms`, resolve with the fallback and move on.
export const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))])
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))
export const json = (v: unknown) => text(JSON.stringify(v, null, 2))
// An actionable error the model can recover from (per the MCP spec, isError text is
// fed back to the agent so it self-corrects), rather than an opaque failure.
export const err = (s: string) => ({
  content: [{ type: "text" as const, text: s }],
  isError: true as const,
})

// Above this, a section-less read of a sectionable doc returns its OUTLINE instead of
// a blind dump: ~9k tokens leaves room to read on, small enough that most docs still
// arrive whole. Measured on the formatted body, not the raw source.
export const FULL_DOC_MAX = 30_000

// publish guardrails — reject inline payloads that belong out-of-band, BEFORE writing,
// with an error naming the `stage` mode to use. A single base64 data: URI past this is a
// binary pasted through the tool call — it should be an asset (stage target:'asset').
export const MAX_INLINE_DATA_URI_BYTES = 32 * 1024
// Total inline `content` (or summed `files`) past this is a whole big document that
// should be curled out-of-band (stage target:'doc') instead of chunked through context.
export const MAX_INLINE_CONTENT_BYTES = 64 * 1024
// The decoded byte size of the LARGEST single base64 data: URI in a string (0 if none) —
// base64 encodes 3 bytes per 4 chars, so decoded ≈ payload_chars * 3/4.
export const largestInlineDataUriBytes = (s: string): number => {
  let max = 0
  for (const m of s.matchAll(/data:[\w/+.-]+;base64,([A-Za-z0-9+/=]+)/g)) {
    const bytes = Math.floor(((m[1] ?? "").length * 3) / 4)
    if (bytes > max) max = bytes
  }
  return max
}

// Cap on landmark regions in a headless-page map: a card grid can have thousands of
// top-level sections/articles, and the map (built to AVOID a wall of text) must not
// itself blow the response budget. The rest are summarized as a "+N more" count.
export const PAGE_MAP_MAX = 50

// clip(), but the truncation steer names sections that actually resolve.
export const clipDoc = (s: string, sections: OutlineSection[]) => {
  if (s.length <= MAX_CHARS) return s
  const steer = sections.length
    ? `read a section instead: ${sections
        .slice(0, 12)
        .map((x) => x.slug)
        .join(", ")}${sections.length > 12 ? ", …" : ""}`
    : "no headings to section by — read a past `version`, or ask for the raw file"
  return `${s.slice(0, MAX_CHARS)}\n\n…[truncated ${s.length - MAX_CHARS} of ${s.length} chars — ${steer}]`
}

// The context-session transcript clipper (used by `use`'s asker reply + runner serve):
// a generous cap on a settled answer, a tight one per transcript entry — together under
// clipDoc's MAX_CHARS ceiling — with a steer to the console, which holds the full transcript.
export const ANSWER_MAX = 40_000
export const ENTRY_MAX = 1_500
export const clipSessionText = (s: string, max: number, consoleUrl: string): string =>
  s.length > max
    ? `${s.slice(0, max)}\n\n…[truncated ${s.length - max} of ${s.length} chars — full transcript in the console: ${consoleUrl}]`
    : s

// A content-bearing response: a frontmatter-style header, a blank line, then the RAW
// body — one text block, real newlines, never JSON-escaped. When a client spills it
// to a file, that file is line-oriented and greppable (the old JSON envelope turned a
// 68k-char document into one escaped line). Receipts and outlines stay `json()`.
export const doc = (meta: Record<string, string | number | null | undefined>, body: string) => {
  const head = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")
  return text(`---\n${head}\n---\n\n${body}`)
}

export const formatLabel = (contentType: string, format: ReadFormat): string => {
  if (format === "markdown")
    return isHtmlLike(contentType)
      ? `markdown (converted from ${baseType(contentType)})`
      : "markdown (source)"
  return format === "html" ? "html (source)" : "text (visible text)"
}

// Images a read can inline as a real MCP image block (vision models see the mockup
// screenshot instead of PNG bytes decoded as garbage text). Larger ones return
// metadata + the served URL — open it in a browser instead.
export const IMAGE_INLINE_MAX = 1_000_000
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
// Dependency-free base64 (no Buffer — this file runs on the Workers tier).
export const toBase64 = (bytes: Uint8Array): string => {
  let out = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += B64[a >> 2]
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? "=" : B64[c & 63]
  }
  return out
}

/**
 * A numeric tool parameter that COERCES (a stale client sends numbers as strings — see
 * scripts/check-mcp-coercion.mjs) and, when that happens, records which parameter it was.
 *
 * A string arriving where the schema says number is PROOF that the client validated
 * against a cached tool schema predating this parameter. That proof is worth surfacing:
 * until now the server just quietly coerced, so an agent could hold a stale surface for
 * its whole life with no signal — and every fix so far has been the server bending
 * further around old clients, which works and does not scale.
 *
 * The tracker is per-REQUEST (this server builds a fresh McpServer and ToolContext per
 * request), so the schema closure and the response that reports it always agree.
 *
 * NOT yet paired with a `notifications/tools/list_changed` push. That was the other half
 * of the design, and it is gated on an unrun experiment: whether real clients act on that
 * notification when it arrives on a POST response stream is a question about client
 * implementations, not about the spec, and shipping a nudge whose effect nobody has
 * observed would be indistinguishable from shipping nothing. The note below is the part
 * that provably reaches the agent.
 */
export const staleAwareNumber = (
  record: (param: string) => void,
  param: string,
  // Bounds ride HERE rather than being .pipe()d on by the caller, so `z.coerce.number()`
  // stays the only numeric schema in the tool surface — a caller-side `.pipe(z.number())`
  // is textually a bare z.number() and check-mcp-coercion.mjs is right to reject it, since
  // it cannot see that something upstream already coerced.
  bounds?: { int?: boolean; min?: number; max?: number },
) => {
  let inner = z.coerce.number()
  if (bounds?.int) inner = inner.int()
  if (bounds?.min !== undefined) inner = inner.min(bounds.min)
  if (bounds?.max !== undefined) inner = inner.max(bounds.max)
  return z.preprocess((v) => {
    if (typeof v === "string") record(param)
    return v
  }, inner)
}

/** The note appended when a call proved its client's schema is stale. Names the parameter
 *  (so the agent knows WHICH capability it may be missing) and the one action that fixes
 *  it, which is the agent's to take, not the server's. */
export const staleSchemaNote = (params: string[]): string =>
  `Your client sent ${params.map((p) => `\`${p}\``).join(", ")} as text where this tool expects a number, which means it validated against a tool schema cached before ${params.length > 1 ? "those parameters" : "that parameter"} existed. It worked (the server coerces), but your cached surface is out of date and other capabilities added since may be invisible to you: reconnect to refresh it.`

/** Most versions a single data-slot series read returns. A trend read must stay one
 *  bounded response: past this the caller narrows the range, and is told so rather than
 *  silently getting a prefix. */
export const DATA_SERIES_MAX = 200

/**
 * A version range for the data-slot trend read: "1-30", "12" (one), "20-" (to the
 * current version), or "all". Deliberately the same shape as `parseLineRange` — one
 * range grammar across the tool, so an agent that learned `lines` already knows this —
 * with `all` added because "every version" is the common ask here and "1-" reads oddly.
 * Clamped to the artifact's real version count; null when malformed or inverted.
 */
export const parseVersionRange = (
  spec: string,
  current: number,
): { from: number; to: number } | null => {
  const cleaned = spec
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .trim()
    .toLowerCase()
  if (cleaned === "all" || cleaned === "*") return { from: 1, to: current }
  const m = cleaned.match(/^(\d+)(?:-(\d*))?$/)
  if (!m) return null
  const from = Number(m[1])
  if (from < 1 || from > current) return null
  const to = m[2] === undefined ? from : m[2] === "" ? current : Number(m[2])
  if (to < from) return null
  return { from, to: Math.min(to, current) }
}

/** Parse stored JSON, falling back to the raw text. Slot bodies are validated at publish,
 *  so this only bends for a row written before that guarantee existed. */
export const safeJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

// A 1-indexed, inclusive line range for windowed reads: "40-120", "40" (one line),
// or "40-" (from 40 to the end). Returns null on a malformed, inverted, or
// out-of-range start (a `from` past the end has no valid window — the caller errors
// with the real line count rather than returning an empty "999-5" window).
export const parseLineRange = (
  spec: string,
  total: number,
): { from: number; to: number } | null => {
  // Forgiving: agents sometimes wrap the range in stray quotes (lines:'"40-120"') or
  // whitespace — strip surrounding quotes/space before matching, so "40-120" and
  // '"40-120"' parse identically.
  const cleaned = spec
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .trim()
  const m = cleaned.match(/^(\d+)(?:-(\d*))?$/)
  if (!m) return null
  const from = Number(m[1])
  if (from < 1 || from > total) return null
  const to = m[2] === undefined ? from : m[2] === "" ? total : Number(m[2])
  if (to < from) return null
  return { from, to: Math.min(to, total) }
}

export const summarizeArtifact = (a: ArtifactRecord) => ({
  short_id: a.short_id,
  title: a.title,
  kind: a.kind,
  // Skill-ness rides the denormalized content type — a skill is a bundle, so `kind`
  // alone can't distinguish it from a docs/site bundle. Surfaced so an agent can spot
  // reusable procedure without opening each bundle.
  is_skill: a.current_content_type === SKILL_CONTENT_TYPE,
  version: a.current_version,
  workspace_access: a.workspace_access,
  link_role: a.link_role,
  listed: a.listed,
  removed: !!a.removed_at,
})

export const summarizeVersion = (v: VersionRecord) => ({
  n: v.n,
  name: v.name,
  message: v.message,
  author: v.author,
  created_at: v.created_at,
})

export const summarizeComment = (c: {
  thread_id: string
  author: string
  state?: string
  base_version?: number
  anchor: string | null
  path?: string | null
  body_md: string
}) => ({
  thread: c.thread_id,
  author: c.author,
  ...(c.state ? { state: c.state } : {}),
  ...(c.base_version != null ? { base_version: c.base_version } : {}),
  quote: quoteOf(c.anchor),
  ...(c.path ? { path: c.path } : {}),
  body: c.body_md,
})

// A version's bundle manifest, presented cleanly. Lets the loop tools see a
// multi-page artifact's actual files, not just its entry doc.
export const manifestOf = (ctx: AppContext, v: VersionRecord) => sharedManifestOf(ctx.blobs, v)

// Which pages changed between two bundle versions — by comparing each file's
// content-addressed blob key. This is the "what's new" a coalesced catch-up needs.
export const bundleFileChanges = (from: BundleManifest, to: BundleManifest) => ({
  added: Object.keys(to.files)
    .filter((p) => !from.files[p])
    .map(cleanPath),
  removed: Object.keys(from.files)
    .filter((p) => !to.files[p])
    .map(cleanPath),
  changed: Object.keys(to.files)
    .filter((p) => {
      const f = from.files[p]
      const t = to.files[p]
      return f && t && f.key !== t.key
    })
    .map(cleanPath),
})

export const changeCount = (c: ReturnType<typeof bundleFileChanges>) =>
  c.added.length + c.changed.length + c.removed.length

// The console's liveness window: a runner is "online" while its last queue
// poll (stamped at most once a minute) is within this.
export const RUNNER_ONLINE_MS = 90_000
export const runnerOnline = (x: ContextRecord) =>
  !!x.runner_seen_at && Date.now() - new Date(x.runner_seen_at).getTime() < RUNNER_ONLINE_MS

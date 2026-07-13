import {
  type ArtifactRecord,
  applyEdits,
  type DiffOp,
  type DocEdit,
  diffLines,
  EditError,
  toMarkdown,
  type VersionRecord,
} from "@derive/core"
import { log } from "../log"

/** A conflict with the artifact's actual state (wrong kind, or it moved past the
 *  version you read) — distinct from a malformed edit itself (bad JSON, 0/multi-match)
 *  so REST callers can map it to 409 instead of 400, matching the pre-consolidation
 *  status codes this helper's callers already committed to in their tests. */
export class EditConflictError extends EditError {}

// Keep a stale-version conflict's diff short — it's context inside an error message,
// not a full read, so an unrelated change deep in a large doc must not drown it in
// hundreds of unchanged context lines. Unified-diff-hunk style: only changed lines
// plus `context` lines either side, long unchanged runs collapsed to "…". A final
// char cap is still a safety net for a document that changed almost entirely.
const CONFLICT_DIFF_MAX = 800
const compactDiff = (ops: DiffOp[], context = 1): string => {
  const keep = new Array<boolean>(ops.length).fill(false)
  ops.forEach((o, i) => {
    if (o.t === "ctx") return
    for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++)
      keep[j] = true
  })
  const lines: string[] = []
  let last = -2
  ops.forEach((o, i) => {
    if (!keep[i]) return
    // i > 0 guard: without it, the very first kept line always looks like it has a
    // gap before it (last starts at -2), printing a spurious "…" even when nothing
    // precedes the diff at all.
    if (i > last + 1 && i > 0) lines.push("…")
    lines.push(`${o.t === "add" ? "+" : o.t === "del" ? "-" : " "} ${o.line}`)
    last = i
  })
  const out = lines.join("\n")
  if (out.length <= CONFLICT_DIFF_MAX) return out

  // A near-total rewrite collapses nothing (no "…" at all — every line differs, so
  // every op survives context expansion): a blind char slice would land mid-line and
  // show a random truncated fragment instead of a useful summary. Report counts.
  if (!lines.includes("…")) {
    const added = ops.filter((o) => o.t === "add").length
    const removed = ops.filter((o) => o.t === "del").length
    return `${added} line${added === 1 ? "" : "s"} added, ${removed} line${removed === 1 ? "" : "s"} removed — too different to summarize as a diff.`
  }

  // Otherwise real hunks survived but are still long: trim to a whole-line boundary
  // rather than cutting mid-word.
  const truncated = out.slice(0, CONFLICT_DIFF_MAX)
  const lastNewline = truncated.lastIndexOf("\n")
  return `${lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated}\n…[truncated]`
}

export interface MaterializeEditsDeps {
  getVersion: (artifactId: string, n: number) => Promise<VersionRecord | null>
  sourceText: (v: Pick<VersionRecord, "blob_key" | "content_type">) => Promise<string | null>
}

export interface MaterializedEdits {
  content: string
  filename: string
}

/** A filename that round-trips `contentType` through the publish sniffer (which types
 *  by filename first). Any revision of an existing single-file artifact that doesn't
 *  carry an explicit filename must go through this — an `index.html` default silently
 *  re-types a markdown doc as HTML, and the browser then swallows its text as markup. */
export const preservingFilename = (contentType: string | null): string =>
  (contentType ?? "").split(";")[0]?.trim() === "text/markdown" ? "index.md" : "index.html"

// diffLines is O(n·m) in line count. Single-file artifacts scale up to
// MAX_UPLOAD_BYTES, and this path fires on every stale-base_version conflict —
// unlike catch_up's equivalent detailed diff, it isn't opt-in. Skip it above a size
// that's already measurably slow locally (~490ms at ~5,000 lines / ~200KB) rather
// than let ordinary concurrent editing on a larger document turn a routine conflict
// response into a multi-second (or unbounded) request.
const CONFLICT_DIFF_MAX_SRC_CHARS = 150_000

// A short line diff (readable Markdown form, like catch_up's detailed diff) between
// the version an edit was based on and the artifact's actual current version — best
// effort: any lookup failure (a purged version, an unreadable blob) falls back to no
// diff rather than failing the conflict report itself. The failure is still logged
// (not silently swallowed) so a genuine bug here doesn't go invisible.
const conflictDiffNote = async (
  deps: MaterializeEditsDeps,
  artifact: Pick<ArtifactRecord, "id" | "current_version">,
  baseVersion: number,
): Promise<string> => {
  if (baseVersion < 1 || baseVersion >= artifact.current_version) return ""
  try {
    const [base, head] = await Promise.all([
      deps.getVersion(artifact.id, baseVersion),
      deps.getVersion(artifact.id, artifact.current_version),
    ])
    if (!base || !head) return ""
    const [baseSrc, headSrc] = await Promise.all([deps.sourceText(base), deps.sourceText(head)])
    if (baseSrc === null || headSrc === null) return ""
    if (
      baseSrc.length > CONFLICT_DIFF_MAX_SRC_CHARS ||
      headSrc.length > CONFLICT_DIFF_MAX_SRC_CHARS
    )
      return ""
    const ops = diffLines(
      toMarkdown(baseSrc, base.content_type),
      toMarkdown(headSrc, head.content_type),
    )
    if (!ops.some((o) => o.t !== "ctx")) return "" // identical readable text — nothing to show
    return `\n\nWhat changed (v${baseVersion} → v${artifact.current_version}):\n${compactDiff(ops)}`
  } catch (err) {
    log.error("conflictDiffNote failed — returning the conflict without a diff", {
      artifactId: artifact.id,
      baseVersion,
      currentVersion: artifact.current_version,
      error: err instanceof Error ? err.message : String(err),
    })
    return ""
  }
}

/**
 * Turn an `edits` request into stored-revision bytes: validate the artifact can take
 * edits at all (single-file, `base_version` still fresh), load its current source,
 * apply the edits, and infer a content-type-preserving filename. Shared by the MCP
 * `publish` tool and the REST `/versions` + `/proposals` routes — the three surfaces
 * that offer `edits` — so the semantics and error text can't drift between them the
 * way they had (mismatched wording, and the MCP path silently skipping the size/
 * storage-quota check the REST routes both apply after calling this).
 *
 * Throws `EditConflictError` for a state conflict (409-shaped), plain `EditError` for
 * a malformed edit (400-shaped) — never a partial/silent failure. Callers translate
 * to their own error shape (MCP `err()`, REST `fail(c, status, …)`); check
 * `instanceof EditConflictError` BEFORE `instanceof EditError` (it's a subclass).
 */
export async function materializeEdits(
  deps: MaterializeEditsDeps,
  artifact: Pick<ArtifactRecord, "id" | "short_id" | "kind" | "current_version">,
  edits: DocEdit[],
  baseVersion: number | undefined,
): Promise<MaterializedEdits> {
  if (artifact.kind !== "file")
    throw new EditConflictError(
      `"${artifact.short_id}" is a multi-page bundle — \`edits\` applies to single-file artifacts; republish the changed page via \`files\` (+ \`merge\`).`,
    )
  if (baseVersion !== undefined && baseVersion !== artifact.current_version) {
    const head = `"${artifact.short_id}" moved to v${artifact.current_version} while you were editing (you read v${baseVersion}).`
    // Show WHAT changed, not just that it did — a human (or another agent) may have
    // published in between, and seeing the delta often tells you whether your edit
    // still makes sense at all, without a separate catch_up round trip.
    const diffNote = await conflictDiffNote(deps, artifact, baseVersion)
    throw new EditConflictError(`${head}${diffNote} Re-read, then retry.`)
  }
  const cur = await deps.getVersion(artifact.id, artifact.current_version)
  const src = cur ? await deps.sourceText(cur) : null
  if (!cur || src === null)
    throw new EditError(`Couldn't load the current source of "${artifact.short_id}".`)
  const content = applyEdits(src, edits)
  // Keep the artifact's content type: the sniffer types by filename first, and the
  // default index.html would silently re-type an edited markdown doc as HTML.
  return { content, filename: preservingFilename(cur.content_type) }
}

/** Parse a `base_version` value from an untyped form field: `undefined` when absent,
 *  `EditError` (not silent NaN-passthrough) when present but not a clean integer —
 *  a malformed field must fail loudly, not coerce to NaN and reject every edit as
 *  "moved to vNaN" regardless of whether the artifact actually moved. */
export function parseBaseVersion(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1)
    throw new EditError(`base_version "${raw}" is not a valid version number.`)
  return n
}

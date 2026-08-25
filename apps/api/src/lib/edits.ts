import {
  type AnyDocEdit,
  type ArtifactRecord,
  applyEdits,
  applyElementEdits,
  applyQuoteEdits,
  applySceneEdits,
  applySlideOps,
  type DiffOp,
  type DocEdit,
  diffLines,
  EditError,
  type ElementEdit,
  isElementEdit,
  isHtmlLike,
  isQuoteEdit,
  isSceneEdit,
  type QuoteEdit,
  type SceneEdit,
  type SlideOp,
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

/** Hard cap on edits per request — see the guard in materializeEdits. */
export const MAX_EDITS_PER_BATCH = 500

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
 * `publish` tool and the REST `/versions` route — the two surfaces
 * that offer `edits` — so the semantics and error text can't drift between them the
 * way they had (mismatched wording, and the MCP path silently skipping the size/
 * storage-quota check the REST route applies after calling this).
 *
 * Throws `EditConflictError` for a state conflict (409-shaped), plain `EditError` for
 * a malformed edit (400-shaped) — never a partial/silent failure. Callers translate
 * to their own error shape (MCP `err()`, REST `fail(c, status, …)`); check
 * `instanceof EditConflictError` BEFORE `instanceof EditError` (it's a subclass).
 */
async function currentSource(
  deps: MaterializeEditsDeps,
  artifact: Pick<ArtifactRecord, "id" | "short_id" | "kind" | "current_version">,
  baseVersion: number | undefined,
  field: string,
): Promise<{ src: string; contentType: string | null }> {
  if (artifact.kind !== "file")
    throw new EditConflictError(
      `"${artifact.short_id}" is a multi-page bundle — \`${field}\` applies to single-file artifacts; republish the changed page via \`files\` (+ \`merge\`).`,
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
  return { src, contentType: cur.content_type }
}

/**
 * Turn a `slide_ops` request into stored-revision bytes: the structural sibling of
 * `materializeEdits`, sharing its kind check, `base_version` staleness check and source
 * load so the two can't drift apart.
 *
 * Structural intent (move / delete / duplicate / insert a slide) exists as its own payload because
 * the text pipelines cannot express it: a quote edit refuses any span crossing an element
 * boundary, and `old_str` can only move a slide by carrying two byte-perfect copies of it
 * through a model's output. Position in, position out — the whole slide never travels.
 */
export async function materializeSlideOps(
  deps: MaterializeEditsDeps,
  artifact: Pick<ArtifactRecord, "id" | "short_id" | "kind" | "current_version">,
  ops: SlideOp[],
  baseVersion: number | undefined,
): Promise<MaterializedEdits> {
  const { src, contentType } = await currentSource(deps, artifact, baseVersion, "slide_ops")
  if (!isHtmlLike(contentType ?? "text/html"))
    throw new EditError(
      `"${artifact.short_id}" isn't an HTML document, so it has no slides to arrange.`,
    )
  // The routes JSON.parse the field without shape-checking it — a non-array must be a
  // clean 400, not a TypeError-shaped 500.
  if (!Array.isArray(ops)) throw new EditError("`slide_ops` must be a JSON array of ops.")
  const content = applySlideOps(src, ops)
  // A batch that changes nothing must not become a version. `{op:"move", from:2, to:2}` is
  // a no-op by construction, and so is any sequence that cancels out — but a publish is
  // never free: it bumps the version, fires webhooks, re-queues three screenshot renders and
  // re-derives every fact. An agent looping with an off-by-one would mint history forever.
  // Saying so is also more useful than silently doing nothing, which reads as success.
  // (Identity stamping DOES change bytes, so a class-only deck's first arrange still lands.)
  if (content === src)
    throw new EditError(
      "Those slide_ops leave the deck exactly as it is, so there is nothing to publish. Check the positions against `read(short_id, map:true)`.",
    )
  return { content, filename: preservingFilename(contentType) }
}

export async function materializeEdits(
  deps: MaterializeEditsDeps,
  artifact: Pick<ArtifactRecord, "id" | "short_id" | "kind" | "current_version">,
  edits: AnyDocEdit[],
  baseVersion: number | undefined,
): Promise<MaterializedEdits> {
  const { src, contentType } = await currentSource(deps, artifact, baseVersion, "edits")
  // Three edit shapes share the field: quote-scoped text edits, element-scoped
  // operations from the rendered editor, and exact-source {old_str,new_str} edits.
  // Quote + element edits may be one atomic inline-editor save; exact-source edits
  // use different ordering semantics and therefore cannot mix with either shape.
  // The routes JSON.parse the field without shape-checking it — a non-array here
  // must be a clean 400 (EditError), not a TypeError-shaped 500.
  if (!Array.isArray(edits)) throw new EditError("`edits` must be a JSON array of edits.")
  // A hard batch cap: each quote edit costs full-document regex scans, and the
  // per-request write limiter bounds request COUNT, not per-request CPU. The inline
  // editor emits one edit per changed text run — dozens at the outside.
  if (edits.length > MAX_EDITS_PER_BATCH)
    throw new EditError(
      `\`edits\` has ${edits.length} entries — the maximum per request is ${MAX_EDITS_PER_BATCH}. Split the batch.`,
    )
  const quoteEdits: QuoteEdit[] = []
  const elementEdits: ElementEdit[] = []
  const sceneEdits: SceneEdit[] = []
  const strEdits: DocEdit[] = []
  for (const e of edits) {
    if (isQuoteEdit(e)) quoteEdits.push(e)
    else if (isElementEdit(e)) elementEdits.push(e)
    else if (isSceneEdit(e)) sceneEdits.push(e)
    else strEdits.push(e as DocEdit)
  }
  if (!quoteEdits.length && !elementEdits.length && !sceneEdits.length && !strEdits.length)
    throw new EditError("`edits` is empty — provide at least one edit.")
  // The two shapes resolve against DIFFERENT baselines (quotes against the stored
  // source all-at-once; old_str edits sequentially, each seeing the previous
  // result). A mixed batch would silently reorder — a caller's old_str targeting
  // text a quote edit rewrote would miss, or worse, match elsewhere — so mixing is
  // refused outright rather than given order-dependent semantics.
  if (strEdits.length && quoteEdits.length)
    throw new EditError(
      "`edits` mixes quote edits and old_str edits — send the two shapes as separate requests.",
    )
  if (strEdits.length && elementEdits.length)
    throw new EditError(
      "`edits` mixes element edits and old_str edits — send the two shapes as separate requests.",
    )
  if (strEdits.length && sceneEdits.length)
    throw new EditError(
      "`edits` mixes scene edits and old_str edits — send the two shapes as separate requests.",
    )
  let content = src
  if (strEdits.length) content = applyEdits(src, strEdits)
  else {
    // Element operations resolve against the untouched base first. A resize changes
    // attributes only, so the visible-text projection quote edits use is identical.
    // This lets one Save carry typed text and resized media atomically.
    if (elementEdits.length) {
      if (!isHtmlLike(contentType ?? "text/html"))
        throw new EditError("Element edits apply to HTML documents, not Markdown.")
      content = applyElementEdits(content, elementEdits)
    }
    if (quoteEdits.length) content = applyQuoteEdits(content, contentType ?? "", quoteEdits)
    // Structural scene operations run last, so duplicating a scene also carries any
    // text the person changed in it during the same atomic Save.
    if (sceneEdits.length) {
      if (contentType !== "text/x-derive-video")
        throw new EditError("Scene edits apply to HTML video artifacts only.")
      content = applySceneEdits(content, sceneEdits)
    }
  }
  // Keep the artifact's content type: the sniffer types by filename first, and the
  // default index.html would silently re-type an edited markdown doc as HTML.
  return { content, filename: preservingFilename(contentType) }
}

/** Parse a `base_version` value from an untyped form field: `undefined` when absent,
 *  `EditError` (not silent NaN-passthrough) when present but not a clean integer —
 *  a malformed field must fail loudly, not coerce to NaN and reject every edit as
 *  "moved to vNaN" regardless of whether the artifact actually moved. */
export function parseBaseVersion(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  if (!/^[1-9]\d*$/.test(raw))
    throw new EditError(`base_version "${raw}" is not a valid version number.`)
  const n = Number(raw)
  if (!Number.isSafeInteger(n))
    throw new EditError(`base_version "${raw}" is not a valid version number.`)
  return n
}

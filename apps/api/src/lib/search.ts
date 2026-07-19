import {
  type ArtifactRecord,
  type BlobStore,
  elideDataUris,
  enclosingMarker,
  isHtmlLike,
  type MetaStore,
  pageText,
  type SearchIndex,
  type SectionMarker,
  sectionMarkers,
  toMarkdown,
  type VersionRecord,
} from "@derive/core"
import { log } from "../log"
import { cleanPath, manifestOf } from "./bundle"
import { clip } from "./clip"

// The minimal store surface search needs — a BlobStore, a version→text resolver
// (works for a version OR a proposal, same as the rest of the app), and (only for
// workspace-wide search) the artifact-listing slice of MetaStore. Narrow deps over
// the full AppContext, same convention as MaterializeEditsDeps in edits.ts: keeps
// this file testable without booting a real app, and importable from a REST route
// or the MCP tool alike without either depending on the other.
export interface SearchDeps {
  blobs: BlobStore
  sourceText: (v: Pick<VersionRecord, "blob_key" | "content_type">) => Promise<string | null>
}

export interface WorkspaceSearchDeps extends SearchDeps {
  meta: {
    listArtifacts(opts: {
      orgId?: string
      viewerId?: string
      publicOnly?: boolean
      excludeRemoved?: boolean
      ids?: string[]
      limit?: number
    }): Promise<ArtifactRecord[]>
    getVersion(artifactId: string, n: number): Promise<VersionRecord | null>
    searchArtifactIds(
      orgId: string,
      query: string,
      limit: number,
    ): Promise<{ id: string; rank: number }[]>
  }
  /** The optional dense/semantic arm (pgvector + an embedder). Absent when no embedder is
   *  configured (or on SQLite) ⇒ nomination stays pure-lexical, byte-identical to before. */
  search?: SearchIndex
}

// ---------------------------------------------------------------------------
// Content presentation — shared with `read`: `markdown` converts HTML, `text` is
// the flat visible text (what comment quotes anchor against, and what a text-scope
// search greps), `html` is the exact source.
// ---------------------------------------------------------------------------

export type ReadFormat = "markdown" | "html" | "text"
export const baseType = (t: string): string => t.split(";")[0]?.trim() ?? t
export const isTextType = (t: string): boolean =>
  baseType(t) === "text/html" || baseType(t) === "text/markdown"
// Only the `markdown` format elides data: URIs (never `html`, which `edits` matches
// byte-for-byte against, or `text`, the comment-anchor source) — see elideDataUris.
export const present = (source: string, contentType: string, format: ReadFormat): string => {
  if (format === "html") return source
  if (format === "text") return isHtmlLike(contentType) ? pageText(source) : source
  return elideDataUris(toMarkdown(source, contentType))
}

// ---------------------------------------------------------------------------
// The grep engine
// ---------------------------------------------------------------------------

// The compiled matcher for `search`. The query is matched LITERALLY: metacharacters
// are escaped so an agent pasting "$31k" or "a.b()" matches verbatim, and — because a
// literal has no quantifiers — the scan is linear even on a multi-MB minified line.
// (Arbitrary user regex is deliberately NOT accepted: catastrophic backtracking on a
// long line blows the Workers CPU budget, and there is no linear-time regex engine on
// this tier. Re-add regex only behind a re2-style matcher.)
export const searchMatcher = (query: string, caseSensitive: boolean): RegExp =>
  new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "g" : "gi")

// One line-oriented match hunk: the matched line plus its context, with line numbers.
// A hit line carries `section` (the heading/region it falls under, when known) so a hit
// deep in a doc is self-locating — annotated per hit line, not per hunk, so two matches
// in different sections that merged into one hunk are each labelled correctly.
export interface SearchHunk {
  from: number
  lines: { n: number; text: string; hit: boolean; section?: string }[]
}

// Tag each HIT line with the section it falls under. No-op when there are no markers
// (an unstructured doc, or a text-scope search whose line numbers don't align with the
// source the markers come from).
export const annotateSections = (hunks: SearchHunk[], markers: SectionMarker[]): void => {
  if (!markers.length) return
  for (const h of hunks)
    for (const l of h.lines) {
      if (!l.hit) continue
      const label = enclosingMarker(markers, l.n)
      if (label) l.section = label
    }
}

// Scan `content` for `re` line by line, ripgrep-style: each matching line becomes a
// hunk carrying `context` lines either side. Adjacent/overlapping hunks merge so a
// run of hits reads as one block. Caps at `max` matches; returns whether it was cut.
export const scanLines = (
  content: string,
  re: RegExp,
  context: number,
  max: number,
): { hunks: SearchHunk[]; total: number } => {
  const lines = content.split("\n")
  const hitRows: number[] = []
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0
    if (re.test(lines[i] as string)) hitRows.push(i)
  }
  const capped = hitRows.slice(0, max)
  const hunks: SearchHunk[] = []
  for (const row of capped) {
    const lo = Math.max(0, row - context)
    const hi = Math.min(lines.length - 1, row + context)
    const last = hunks[hunks.length - 1]
    // Merge into the previous hunk when its context window touches this one.
    if (last && lo <= last.from - 1 + last.lines.length) {
      for (let i = last.from - 1 + last.lines.length; i <= hi; i++)
        last.lines.push({ n: i + 1, text: lines[i] as string, hit: false })
      last.lines[row - (last.from - 1)] = { n: row + 1, text: lines[row] as string, hit: true }
      continue
    }
    const block: SearchHunk["lines"] = []
    for (let i = lo; i <= hi; i++)
      block.push({ n: i + 1, text: lines[i] as string, hit: i === row })
    hunks.push({ from: lo + 1, lines: block })
  }
  return { hunks, total: hitRows.length }
}

// Render hunks ripgrep-style: `  142: hit line` for matches, `  141- context` for
// context, a blank line between hunks. A `§ Section` header precedes a run of hunks
// that share an enclosing heading/region, so each match is self-locating. Line text is
// trimmed of a trailing CR and clipped so one enormous minified line can't blow budget.
const LINE_CLIP = 400
export const renderHunks = (hunks: SearchHunk[]): string => {
  const blocks: string[] = []
  let section: string | undefined
  for (const h of hunks) {
    const rows: string[] = []
    for (const l of h.lines) {
      // A `§ Section` header whenever a hit enters a new section — so a merged hunk
      // spanning two sections labels each correctly.
      if (l.hit && l.section && l.section !== section) {
        section = l.section
        rows.push(`§ ${section}`)
      }
      const t = l.text.replace(/\r$/, "")
      const shown = t.length > LINE_CLIP ? `${t.slice(0, LINE_CLIP)}…` : t
      rows.push(`  ${l.n}${l.hit ? ":" : "-"} ${shown}`)
    }
    blocks.push(rows.join("\n"))
  }
  return blocks.join("\n\n")
}

// Render a list of {path, hunks} groups to one text block — a bare block for a
// single-file artifact (path: null), a `path\n` header per page for a bundle. Shared
// by the one-artifact and cross-artifact report formatters below.
export const renderGroups = (groups: { path: string | null; hunks: SearchHunk[] }[]): string =>
  groups
    .filter((g) => g.hunks.length > 0)
    .map((g) => (g.path ? `${g.path}\n${renderHunks(g.hunks)}` : renderHunks(g.hunks)))
    .join("\n\n")

// ---------------------------------------------------------------------------
// One-artifact search — raw source or bundle text pages, batched, section-labelled.
// The single engine both the one-artifact and cross-artifact search paths run.
// ---------------------------------------------------------------------------

export const ARTIFACT_PAGE_SCAN_CAP = 50

export interface ArtifactSearchResult {
  groups: { path: string | null; hunks: SearchHunk[] }[]
  total: number
  note: string | null
}

export const searchArtifactVersion = async (
  deps: SearchDeps,
  v: VersionRecord,
  re: RegExp,
  where: "source" | "text",
  ctxLines: number,
  cap: number,
): Promise<ArtifactSearchResult> => {
  // What each page's searchable content is, in the chosen scope: exact source, or
  // the visible text (tags stripped) for HTML — Markdown/plain ARE their own text.
  const contentFor = (raw: string, ct: string) =>
    where === "text" ? present(raw, ct, "text") : raw
  // Section markers align with the searched content's line numbers only when that
  // content IS the raw source — i.e. any source-scope search, or a markdown/plain
  // text-scope search (its text IS the source). An HTML text-scope search greps the
  // tag-stripped text, whose lines don't map to the source markers, so skip it.
  const markersFor = (raw: string, ct: string): SectionMarker[] =>
    where === "source" || !isHtmlLike(ct) ? sectionMarkers(raw, ct) : []
  const manifest = await manifestOf(deps.blobs, v)

  if (!manifest) {
    const src = (await deps.sourceText(v)) ?? ""
    const { hunks, total } = scanLines(contentFor(src, v.content_type), re, ctxLines, cap)
    annotateSections(hunks, markersFor(src, v.content_type))
    return { groups: [{ path: null, hunks }], total, note: null }
  }

  // Bundle: search every text page (capped), grouped by page. Blob reads run in
  // parallel; non-text files (images, css/js are text but binaries aren't) skip.
  const pages = Object.keys(manifest.files)
    .filter((p) => isTextType(manifest.files[p]?.type ?? ""))
    .sort((x, y) => x.split("/").length - y.split("/").length || x.localeCompare(y))
  const scanned = pages.slice(0, ARTIFACT_PAGE_SCAN_CAP)
  // Scan in bounded batches rather than one Promise.all over all of them: each page
  // is decoded to a string and line-split, and scanLines is synchronous (nothing
  // frees mid-batch), so an unbounded fan-out over large pages could pile decoded
  // copies toward the memory ceiling. Batches keep at most CONCURRENCY live at once.
  const CONCURRENCY = 8
  const scanPage = async (p: string) => {
    const file = manifest.files[p]
    if (!file) return null
    const bytes = await deps.blobs.get(file.key)
    if (!bytes) return null
    const raw = new TextDecoder().decode(bytes)
    const { hunks, total } = scanLines(contentFor(raw, file.type), re, ctxLines, cap)
    annotateSections(hunks, markersFor(raw, file.type))
    return total ? { path: cleanPath(p), hunks, total } : null
  }
  const groups: { path: string; hunks: SearchHunk[]; total: number }[] = []
  for (let i = 0; i < scanned.length; i += CONCURRENCY) {
    const batch = await Promise.all(scanned.slice(i, i + CONCURRENCY).map(scanPage))
    for (const g of batch) if (g) groups.push(g)
  }
  const total = groups.reduce((sum, g) => sum + g.total, 0)
  const note =
    pages.length > ARTIFACT_PAGE_SCAN_CAP
      ? `first ${ARTIFACT_PAGE_SCAN_CAP} of ${pages.length} pages`
      : null
  return { groups, total, note }
}

// Assemble the ripgrep-style one-artifact report: a header with the total, each
// page's hunks (bundle pages labelled), and a steer to act. `cap` names the
// per-page match ceiling so a capped result reads honestly. Clipped to budget.
export const searchReport = (
  shortId: string,
  query: string,
  where: string,
  total: number,
  cap: number,
  groups: { path: string | null; hunks: SearchHunk[] }[],
  note?: string | null,
): string => {
  if (total === 0)
    return `${shortId} — no matches for "${query}" in ${where}.${
      where === "source" ? " Try in:'text' to search the visible text." : ""
    }`
  const head = `${shortId} — ${total} match${total === 1 ? "" : "es"} for "${query}" in ${where}${
    note ? ` (${note})` : ""
  }${total > cap ? `, showing the first ${cap} per page` : ""}`
  // The steer names the format whose line numbers these match, so the follow-up
  // windowed read lands on the same lines: `source` line numbers are the raw source
  // (read format:"html"); `text` line numbers are the visible text (read format:"text").
  const fmt = where === "text" ? "text" : "html"
  const steer = `\n\nRead a spot with read(lines:"from-to", format:"${fmt}"), or edit it via publish edits.`
  return clip(`${head}\n\n${renderGroups(groups)}${steer}`)
}

// ---------------------------------------------------------------------------
// Index maintenance — the WRITE side of workspace search, for BOTH arms: the lexical
// FTS/tsvector index behind searchArtifactIds, and (when bound) the dense SearchIndex.
// emitVersionBump calls indexArtifactVersion on every publish/restore/proposal-approve,
// keeping both current. On delete/move the two diverge by necessity: the FTS lives IN the
// MetaStore, so deleteArtifact/moveArtifactOrg maintain it transactionally; the dense arm
// lives outside the DB, so the delete/move ROUTES unindex/re-scope it best-effort — and any
// orphan left by another path (sync/preview churn, a crash) is reclaimed by the backfill/
// reconcile sweep. Never a leak: the Tier-2 gate drops a stale vector regardless.
// ---------------------------------------------------------------------------

// Bound the indexed text per artifact (in JS chars — real artifacts are far smaller).
// This keeps the index lean and stays comfortably under Postgres's ~1MB-per-tsvector
// ceiling: 256K UTF-16 code units is at most ~1MB of UTF-8, and a tsvector is no larger
// than its input, so `to_tsvector` won't overflow on normal input. Applied on BOTH
// dialects so the index content matches. The tail of a giant doc isn't FTS-findable,
// but once the index nominates the artifact the one-artifact grep still reads the live
// blob in full — so a past-the-bound hit is reported there, just not discovered
// workspace-wide.
export const MAX_INDEX_TEXT = 256 * 1024

// The text an artifact version contributes to the search index: its raw SOURCE — so
// the default source-scope search finds tag/attribute content, not only visible text —
// across every text page of a bundle. The index is a RECALL-APPROXIMATE candidate
// generator, not a strict superset of what grep-confirm reads: data: URIs are elided
// (megabytes of inlined base64 are bloat, never a real target), text past MAX_INDEX_TEXT
// is dropped, and — because the source is indexed, not the rendered text — an `in:'text'`
// query for a word split across inline tags (foo<b>bar</b> → visible "foobar") may not
// be nominated. All three are workspace-discovery gaps only: the one-artifact grep still
// finds those hits directly. A non-text single file (a bare uploaded image) adds nothing.
export async function versionIndexText(blobs: BlobStore, v: VersionRecord): Promise<string> {
  const clipText = (s: string) => (s.length > MAX_INDEX_TEXT ? s.slice(0, MAX_INDEX_TEXT) : s)
  const manifest = await manifestOf(blobs, v)
  if (!manifest) {
    if (!isTextType(v.content_type)) return ""
    const bytes = await blobs.get(v.blob_key)
    return bytes ? clipText(elideDataUris(new TextDecoder().decode(bytes))) : ""
  }
  const pages = Object.keys(manifest.files).filter((p) => isTextType(manifest.files[p]?.type ?? ""))
  const parts: string[] = []
  let used = 0
  for (const p of pages) {
    if (used >= MAX_INDEX_TEXT) break // enough text collected; skip the rest
    const key = manifest.files[p]?.key
    if (!key) continue
    const bytes = await blobs.get(key)
    if (!bytes) continue
    const t = elideDataUris(new TextDecoder().decode(bytes))
    parts.push(t)
    used += t.length
  }
  return clipText(parts.join("\n\n"))
}

// Upsert an artifact's current-version text into the search index. Called from
// emitVersionBump so publish, restore, and proposal-approve all keep it current.
export async function indexArtifactVersion(
  meta: Pick<MetaStore, "indexArtifact">,
  blobs: BlobStore,
  artifact: Pick<ArtifactRecord, "id" | "org_id" | "title">,
  v: VersionRecord,
  search?: Pick<SearchIndex, "indexArtifact">,
): Promise<void> {
  const text = await versionIndexText(blobs, v)
  await meta.indexArtifact(artifact.id, artifact.org_id, artifact.title, text)
  // The dense arm is independently best-effort: a dense-arm (embed or store) hiccup must never undo
  // the lexical upsert that already committed, nor fail the publish. Log and move on — the next
  // publish re-embeds and the backfill sweep is the safety net. (emitVersionBump's own catch
  // covers the lexical arm; this inner catch keeps a dense failure from ever reaching it.)
  if (search) {
    try {
      await search.indexArtifact(artifact.id, artifact.org_id, artifact.title, text)
    } catch (err) {
      log.error("semantic index update failed", { artifact: artifact.id, err: String(err) })
    }
  }
}

// Hard-delete an artifact from BOTH search arms. `meta.deleteArtifact` drops the row + its FTS
// entry inside the DB; the dense vector lives OUTSIDE the DB, so it must be dropped separately —
// best-effort, since an orphan is only wasted storage (the Tier-2 gate filters a stale nomination).
// Every hard-delete path MUST go through this: the dense arm silently drifted from the FTS on the
// repo-sync `wipe` path exactly because it called meta.deleteArtifact directly. Not for takedown
// (that soft-removes, keeping the vector valid) or account deletion (that anonymizes + retains).
export async function deleteArtifactAndUnindex(
  meta: Pick<MetaStore, "deleteArtifact">,
  search: Pick<SearchIndex, "unindexArtifact"> | undefined,
  id: string,
  orgId: string,
): Promise<void> {
  await meta.deleteArtifact(id, orgId)
  if (search)
    await search
      .unindexArtifact(id)
      .catch((err) => log.error("dense unindex failed", { artifact: id, err: String(err) }))
}

// Backfill — index artifacts that predate the write-path (or were created outside it).
// Publishing keeps the index current going forward; this one-time sweep covers the
// existing corpus. Idempotent (indexArtifact upserts), operator-driven in bounded
// batches (POST /v1/system/search-reindex), resumed by passing nextCursor back until
// it's null. Runs at operator scope (no viewerId) but with `excludeRemoved` so it walks
// every LIVE artifact and never indexes a taken-down one.
export interface ReindexSearchDeps {
  blobs: BlobStore
  meta: Pick<MetaStore, "indexArtifact" | "getVersion" | "listArtifacts">
  /** The optional dense arm — backfill embeds into it too when a SearchIndex is bound. */
  search?: SearchIndex
}

export interface ReindexBatchResult {
  scanned: number
  indexed: number
  nextCursor: { key: string; id: string } | null
}

export const reindexSearchBatch = async (
  deps: ReindexSearchDeps,
  opts: { orgId?: string; cursor?: { key: string; id: string }; limit: number },
): Promise<ReindexBatchResult> => {
  const arts = await deps.meta.listArtifacts({
    orgId: opts.orgId,
    cursor: opts.cursor,
    limit: opts.limit,
    excludeRemoved: true,
  })
  let indexed = 0
  const denseItems: { id: string; orgId: string; title: string | null; text: string }[] = []
  for (const a of arts) {
    // Isolate each artifact: a single unreadable blob / transient store error must not
    // abort the whole batch and wedge the operator's cursor (unlike the publish path,
    // this loop is the only driver). Log and move on — the row can be re-swept later.
    try {
      const v = await deps.meta.getVersion(a.id, a.current_version)
      if (!v) continue // no readable current version — skip rather than index empty
      const text = await versionIndexText(deps.blobs, v)
      await deps.meta.indexArtifact(a.id, a.org_id, a.title, text) // lexical arm (synchronous truth)
      denseItems.push({ id: a.id, orgId: a.org_id, title: a.title, text })
      indexed++
    } catch (err) {
      log.error("search reindex skipped one artifact", { artifact: a.id, err: String(err) })
    }
  }
  // Dense arm: batched embed+upsert (in sub-batches) instead of one-per-artifact — far fewer
  // embed calls + vector-store writes, so a bundle-dense page is much less likely to breach the
  // subrequest ceiling. Best-effort, like the publish path: a dense hiccup logs and moves on — the
  // lexical arm already committed and the next publish/sweep re-adds. NOTE: `indexed` counts LEXICAL
  // successes, so a dense-arm failure won't show as `indexed < scanned`; a full re-sweep is the
  // dense safety net.
  if (deps.search && denseItems.length) {
    try {
      await deps.search.indexArtifacts(denseItems)
    } catch (err) {
      log.error("search reindex: dense batch failed", { err: String(err) })
    }
  }
  // A full page implies there may be more; the last row is the keyset for the next call.
  // The sweep takes the store's default order (created-desc), so the cursor key is
  // created_at; listArtifacts otherwise keys the cursor on the active ?sort=. A short page
  // means we've reached the end.
  const last = arts[arts.length - 1]
  const nextCursor =
    arts.length >= opts.limit && last ? { key: last.created_at, id: last.id } : null
  return { scanned: arts.length, indexed, nextCursor }
}

// ---------------------------------------------------------------------------
// Workspace-wide search — two-tier retrieval over the WHOLE corpus: the persisted
// index nominates the most relevant candidate artifacts (searchArtifactIds), those
// ids are re-resolved through the one visibility gate (listArtifacts), and the same
// one-artifact grep engine confirms the exact literal on the top-ranked survivors.
// This replaced a live grep of only the 30 most-RECENT artifacts, which was
// structurally blind to everything older.
// ---------------------------------------------------------------------------

// How many ranked candidates the index returns. Generous headroom over the
// grep-confirm cap so the visibility filter (which drops candidates the viewer can't
// see) still leaves plenty to confirm. Org-ranked, so the top of this window is the
// most relevant across the whole corpus — not the most recent.
export const WORKSPACE_SEARCH_CANDIDATE_CAP = 200

// How many visible, relevance-ranked candidates get the expensive grep-confirm (blob
// read + literal scan). The real cost bound — was the old "scan the 30 most recent",
// now "grep-confirm the 30 most RELEVANT you can see".
export const WORKSPACE_SEARCH_ARTIFACT_CAP = 30

// The candidate ids are resolved through listArtifacts in chunks this size: `ids`
// compiles to `id IN (?…)`, one bound parameter each, and D1 rejects any statement
// with >100 of them (a 500). 90 leaves room for the query's other bound params
// (org, viewer, listed). Postgres could take all 200 at once but chunking is harmless
// there. The chunks are independent visibility queries; their rows just concatenate.
const LIST_ID_CHUNK = 90

// Reciprocal-rank fusion: merge the lexical and dense candidate lists by summing 1/(k+rank)
// across the lists an id appears in (k=60, the standard constant). Rank-based, so it needs no
// score normalization between BM25 and cosine — an id near the top of EITHER arm ranks well, and
// one near the top of BOTH ranks best. Carries the dense arm's `chunk` (the semantic snippet
// source) for the ids the lexical arm didn't also surface. V8's Map preserves insertion order
// and its sort is stable, so ties resolve lexical-first, deterministically. Pure — unit-tested.
export const RRF_K = 60
export const rrfFuse = (
  lexical: { id: string }[],
  dense: { id: string; chunk: string }[],
  limit: number,
): { id: string; chunk?: string }[] => {
  const score = new Map<string, number>()
  const chunkOf = new Map<string, string>()
  for (const [i, r] of lexical.entries())
    score.set(r.id, (score.get(r.id) ?? 0) + 1 / (RRF_K + i + 1))
  for (const [i, r] of dense.entries()) {
    score.set(r.id, (score.get(r.id) ?? 0) + 1 / (RRF_K + i + 1))
    chunkOf.set(r.id, r.chunk)
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => ({ id, chunk: chunkOf.get(id) }))
}

export interface WorkspaceSearchResult {
  short_id: string
  title: string
  current_version: number
  groups: { path: string | null; hunks: SearchHunk[] }[]
  total: number
  /** The query matched the artifact title but not its current document bytes. */
  titleMatch?: boolean
  /** Set only for a dense-nominated hit the literal grep-confirm couldn't reproduce
   *  (total === 0): the best-matching passage, shown as the match evidence. */
  semantic?: { snippet: string }
}

export const searchWorkspace = async (
  deps: WorkspaceSearchDeps,
  opts: {
    orgId: string
    // Omit for an anonymous/non-member caller — mirrors list_artifacts/listArtifacts:
    // pass publicOnly:true in that case so a workspace-visible (not just public)
    // artifact never surfaces to someone who isn't a member. The MCP tool never hits
    // this branch (every MCP caller carries a real agent identity), but the REST
    // route this also backs can be called anonymously.
    viewerId?: string
    publicOnly?: boolean
    // The raw literal query drives the index lookup (`query`) AND the grep-confirm
    // (`re`, the same literal compiled) — both derive from the one user string.
    query: string
    re: RegExp
    where: "source" | "text"
    ctxLines: number
    cap: number
    // How many visible candidates to grep-confirm. Defaults to WORKSPACE_SEARCH_ARTIFACT_CAP
    // (agents want depth); a typeahead surface passes a small value so a debounced keystroke
    // reads only a handful of blobs. NOTE: this bounds only the blob-read + grep stage, not
    // the (indexed, cheap) candidate scan or the visibility resolve — cap those with
    // `candidateCap` when the caller wants the whole request small.
    limit?: number
    // How many ranked candidates to nominate + visibility-check. Defaults to
    // WORKSPACE_SEARCH_CANDIDATE_CAP (deep recall for agents); a typeahead surface passes a
    // small value (≤ LIST_ID_CHUNK) so the visibility resolve is a SINGLE query, not three.
    candidateCap?: number
  },
): Promise<{ results: WorkspaceSearchResult[]; note: string | null }> => {
  const candidateCap = opts.candidateCap ?? WORKSPACE_SEARCH_CANDIDATE_CAP
  // Tier 1 — hybrid nomination across the whole corpus. The lexical FTS runs always (and answers
  // read-your-writes for a just-published doc); the dense/semantic arm runs in parallel WHEN a
  // SearchIndex is bound, and the two are fused by reciprocal-rank fusion. Both are org-scoped and
  // ranked but carry NO visibility knowledge — the Tier-2 gate below is the single authority, so
  // hybrid can't widen what a viewer sees. Over-fetch one past the cap so the fused list keeps a
  // sentinel (never resolved) that answers "were there more?". With no SearchIndex (self-host),
  // `nominated` is byte-for-byte the old pure-lexical candidate list.
  const [lexical, dense] = await Promise.all([
    deps.meta.searchArtifactIds(opts.orgId, opts.query, candidateCap + 1),
    deps.search
      ? deps.search.search(opts.orgId, opts.query, candidateCap).catch((err) => {
          // The dense arm is best-effort on READ too: a dense-arm (embed or store) hiccup degrades this
          // query to lexical-only rather than 500-ing a search the lexical arm could still serve.
          log.error("semantic search arm failed; falling back to lexical", { err: String(err) })
          return [] as { id: string; score: number; chunk: string }[]
        })
      : Promise.resolve([] as { id: string; score: number; chunk: string }[]),
  ])
  const nominated: { id: string; chunk?: string }[] = deps.search
    ? rrfFuse(lexical, dense, candidateCap + 1)
    : lexical.map((r) => ({ id: r.id }))
  if (nominated.length === 0) return { results: [], note: null }
  const moreCandidates = nominated.length > candidateCap
  const candidates = nominated.slice(0, candidateCap)
  const rankOf = new Map(candidates.map((c, i) => [c.id, i]))
  // The best dense passage per candidate — the evidence a semantic-only hit shows when the
  // literal grep-confirm below finds nothing to quote.
  const chunkOf = new Map(candidates.flatMap((c) => (c.chunk ? [[c.id, c.chunk] as const] : [])))

  // Tier 2 gate — THE visibility check. Re-resolve the nominated ids through
  // listArtifacts with the SAME orgId/viewerId/publicOnly list_artifacts uses, PLUS
  // excludeRemoved (the index can outlive a takedown, and listArtifacts keeps tombstones
  // for the feed — so search must drop them explicitly, else a moderated artifact's text
  // is grep-readable). An id the index nominated survives only if this call returns it,
  // so the index — a pure relevance oracle with no access knowledge — can never widen
  // visibility. Chunked to stay under D1's bound-parameter cap (see LIST_ID_CHUNK).
  const visible: ArtifactRecord[] = []
  const candidateIds = candidates.map((c) => c.id)
  for (let i = 0; i < candidateIds.length; i += LIST_ID_CHUNK) {
    const rows = await deps.meta.listArtifacts({
      orgId: opts.orgId,
      viewerId: opts.viewerId,
      publicOnly: opts.publicOnly,
      excludeRemoved: true,
      ids: candidateIds.slice(i, i + LIST_ID_CHUNK),
    })
    visible.push(...rows)
  }
  // A password lock suspends the WORLD LINK until unlocked — `effectiveRole` (permissions.ts)
  // makes `locked && !unlocked` ⇒ the link grants nothing. So a locked artifact is readable
  // ONLY through a non-link grant: a workspace SEAT (workspace_access:"member" opened by a
  // member) or an explicit share. `listArtifacts` is the LISTING gate, not the read gate — a
  // {listed:"public", workspace_access:"none", link_role:"viewer", password:…} doc lists to a
  // member, yet they can open it only via the (locked) link, so its body must not be
  // grep-readable to them (read would 401 "password required"). Keep a locked artifact only
  // when the caller's SEAT grants read: a member (not publicOnly) on a workspace_access:"member"
  // doc. Anonymous/link-only callers — and the rare member reachable solely by an explicit
  // share on a workspace_access:"none" lock — are conservatively dropped: a safe recall loss,
  // never a leak. (A per-candidate `authorize(c,"read",a)` would also honor explicit shares and
  // unlock cookies, but the MCP entry point has no request Context to build that actor from, so
  // this seat-only predicate is the uniform floor both callers share.)
  const gated = visible.filter(
    (a) => !a.password_hash || (!opts.publicOnly && a.workspace_access === "member"),
  )
  // listArtifacts returns in its own (recency) order; restore relevance order.
  gated.sort((a, b) => (rankOf.get(a.id) ?? Infinity) - (rankOf.get(b.id) ?? Infinity))

  // Grep-confirm only the top-N most-relevant survivors — the blob-read+scan is the
  // real cost, so it stays bounded. A candidate the index nominated on token overlap
  // but whose exact literal/scope isn't actually present yields no hunks and drops out
  // here: the index is RECALL, the grep is PRECISION.
  const grepCap = opts.limit ?? WORKSPACE_SEARCH_ARTIFACT_CAP
  const toGrep = gated.slice(0, grepCap)
  // 4, not searchArtifactVersion's inner 8: the two fan-outs compose (a batch of
  // bundles each opens its own 8-wide page fan-out), so peak blob reads is the product
  // — 4×8=32 keeps that worst case reasonable without a cross-cutting semaphore.
  const CONCURRENCY = 4
  const scanArtifact = async (a: ArtifactRecord): Promise<WorkspaceSearchResult | null> => {
    const v = await deps.meta.getVersion(a.id, a.current_version)
    if (!v) return null
    const { groups, total } = await searchArtifactVersion(
      deps,
      v,
      opts.re,
      opts.where,
      opts.ctxLines,
      opts.cap,
    )
    // Literal hunks are the lexical arm's precision. A dense-nominated artifact the literal grep
    // can't confirm (total === 0) is still a real semantic match — keep it, carrying its best
    // chunk as evidence. A pure-lexical miss (no hunks and no chunk) drops out exactly as before.
    // (snippetAround centers on the literal when present; a semantic chunk has none, so it returns
    // the chunk head — which is exactly the evidence we want here.)
    const chunk = chunkOf.get(a.id)
    // The lexical index includes the title as well as the stored bytes. Preserve a title-only hit
    // through confirmation too: otherwise `find({query})` can browse a document by title but not
    // search for that same title. Reset the global matcher before testing it, just as scanLines
    // does for each source line.
    opts.re.lastIndex = 0
    const titleMatch = total === 0 && !!a.title && opts.re.test(a.title)
    if (total === 0 && !chunk && !titleMatch) return null
    return {
      short_id: a.short_id,
      title: a.title ?? a.short_id,
      current_version: a.current_version,
      groups,
      total,
      titleMatch,
      semantic:
        total === 0 && !titleMatch && chunk
          ? { snippet: snippetAround(chunk, opts.query) }
          : undefined,
    }
  }
  const results: WorkspaceSearchResult[] = []
  for (let i = 0; i < toGrep.length; i += CONCURRENCY) {
    const batch = await Promise.all(toGrep.slice(i, i + CONCURRENCY).map(scanArtifact))
    for (const r of batch) if (r) results.push(r)
  }

  // Honest truncation. These are CANDIDATE counts (index nominations that passed
  // visibility), not confirmed-hit counts: grep-confirm may still drop some, so the
  // wording says "candidates", never "matches". `grepTruncated`: more visible candidates
  // than we confirmed. `moreCandidates`: the index had still more below the window
  // (detected by the over-fetched sentinel) — hence the `+`.
  const grepTruncated = gated.length > grepCap
  const note = grepTruncated
    ? `ranked by relevance — grep-confirmed the top ${grepCap} of ${gated.length}${
        moreCandidates ? "+" : ""
      } candidate artifacts you can see; refine the query to reach the rest`
    : moreCandidates
      ? `ranked by relevance — more than ${candidateCap} artifacts matched the index; refine the query to narrow`
      : null
  return { results, note }
}

// Assemble a workspace-wide search report: one `## short_id — title` section per
// matching artifact, each rendered with the same renderGroups the one-artifact
// report uses. `results` is pre-filtered to artifacts that had at least one hit.
export const workspaceSearchReport = (
  query: string,
  where: string,
  results: WorkspaceSearchResult[],
  note: string | null,
): string => {
  const grandTotal = results.reduce((sum, r) => sum + r.total + (r.titleMatch ? 1 : 0), 0)
  // A result with no literal hunks (total 0) but a semantic snippet is a dense-arm match.
  const hasSemantic = results.some((r) => r.total === 0 && r.semantic)
  if (grandTotal === 0 && !hasSemantic)
    return `No matches for "${query}" in ${where} across the workspace${note ? ` (${note})` : ""}.${
      where === "source" ? " Try in:'text' to search the visible text." : ""
    }`
  // Header keeps the exact literal-match wording when there are any (so the lexical-only path —
  // every self-host deploy — is unchanged); an all-dense result set reports a semantic-match
  // count instead of reading as "0 matches".
  const head =
    grandTotal > 0
      ? `${grandTotal} match${grandTotal === 1 ? "" : "es"} for "${query}" in ${where} across ${
          results.length
        } artifact${results.length === 1 ? "" : "s"}${note ? ` (${note})` : ""}`
      : `${results.length} semantic match${results.length === 1 ? "" : "es"} for "${query}" in ${where}${
          note ? ` (${note})` : ""
        }`
  const body = results
    .map((r) =>
      r.total > 0
        ? `## ${r.short_id} — ${r.title}\n${renderGroups(r.groups)}`
        : r.titleMatch
          ? `## ${r.short_id} — ${r.title}\n  ~ title match: ${r.title}`
          : `## ${r.short_id} — ${r.title}  (semantic match)\n  ~ ${r.semantic?.snippet ?? ""}`,
    )
    .join("\n\n")
  const fmt = where === "text" ? "text" : "html"
  const steer = `\n\nOpen one with search(short_id:"...", query:"${query}") for full context, or read(short_id:"...", lines:"from-to", format:"${fmt}").`
  return clip(`${head}\n\n${body}${steer}`)
}

// ---------------------------------------------------------------------------
// JSON hits — the same workspace results shaped for a UI (the ⌘K palette) instead of
// the agent text report: one artifact per hit, with a single-line snippet of WHERE it
// matched so a human sees why it surfaced. The client highlights the term itself.
// ---------------------------------------------------------------------------

export interface SearchHit {
  short_id: string
  title: string
  current_version: number
  /** One line of the matching text, windowed around the first match (…elided ends). */
  snippet: string
  /** True when this is a SEMANTIC-only match — the query matched by meaning, with no literal
   *  occurrence in the text (so the snippet is the dense passage, not a highlightable line). Lets
   *  the UI badge it as a meaning match. A hit found literally (with or without also matching
   *  semantically) is false. */
  semantic: boolean
}

// A short lead of context BEFORE the match, then the rest trailing. The window is biased
// left on purpose: the palette renders the snippet in a single left-truncating line, so a
// centered window would push the highlighted term off the right edge — the common case
// here, where agent-authored markdown writes each paragraph as one long unwrapped line.
const SNIPPET_LEAD = 16
const SNIPPET_LEN = 160

// Window a line so the first occurrence of `query` sits near the visible LEFT edge and
// survives truncation. Whitespace in both the line and the query is collapsed (a source
// line can be deeply indented; a query may carry stray spaces) so the match stays
// locatable. Falls back to the head of the line when the literal isn't on it (shouldn't
// happen after grep-confirm, but stays safe).
export const snippetAround = (line: string, query: string): string => {
  const flat = line.replace(/\s+/g, " ").trim()
  const q = query.replace(/\s+/g, " ").trim()
  const at = q ? flat.toLowerCase().indexOf(q.toLowerCase()) : -1
  if (at < 0) return flat.length > SNIPPET_LEN ? `${flat.slice(0, SNIPPET_LEN)}…` : flat
  const start = Math.max(0, at - SNIPPET_LEAD)
  const end = Math.min(flat.length, start + SNIPPET_LEN)
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`
}

export const toSearchHits = (results: WorkspaceSearchResult[], query: string): SearchHit[] =>
  results.map((r) => {
    // The first HIT line across the artifact's groups is the most relevant snippet source.
    const hit = r.groups.flatMap((g) => g.hunks.flatMap((h) => h.lines)).find((l) => l.hit)
    return {
      short_id: r.short_id,
      title: r.title,
      current_version: r.current_version,
      // A literal hit line is the best snippet; a dense-only hit falls back to its chunk snippet.
      snippet: hit
        ? snippetAround(hit.text, query)
        : r.titleMatch
          ? r.title
          : (r.semantic?.snippet ?? ""),
      // Semantic-only when there's no literal hit line but a dense passage carried it here.
      semantic: !hit && !!r.semantic?.snippet,
    }
  })

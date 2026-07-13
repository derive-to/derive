import {
  type ArtifactRecord,
  type BlobStore,
  elideDataUris,
  enclosingMarker,
  isHtmlLike,
  pageText,
  type SectionMarker,
  sectionMarkers,
  toMarkdown,
  type VersionRecord,
} from "@derive/core"
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
      limit?: number
    }): Promise<ArtifactRecord[]>
    getVersion(artifactId: string, n: number): Promise<VersionRecord | null>
  }
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
// Workspace-wide search — the same one-artifact engine fanned out across the
// artifacts a viewer can see, grouped by artifact.
// ---------------------------------------------------------------------------

// Cap on how many of a workspace's artifacts a workspace-wide search scans (most
// recently created first, same ordering list_artifacts uses) — a live grep with no
// index behind it can't scan an unbounded workspace within one request. Mirrors
// ARTIFACT_PAGE_SCAN_CAP's shape: a documented, honest cap with a truncation note,
// not a silent one.
export const WORKSPACE_SEARCH_ARTIFACT_CAP = 30

export interface WorkspaceSearchResult {
  short_id: string
  title: string
  groups: { path: string | null; hunks: SearchHunk[] }[]
  total: number
}

// Fan out searchArtifactVersion across the artifacts a viewer can see, batched for
// cost (same shape as the bundle-page batching above). listArtifacts is called with
// the SAME viewerId/orgId list_artifacts uses — that's the one true source of what
// an agent can see, so this can't accidentally widen visibility past it.
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
    re: RegExp
    where: "source" | "text"
    ctxLines: number
    cap: number
  },
): Promise<{ results: WorkspaceSearchResult[]; note: string | null }> => {
  const arts = await deps.meta.listArtifacts({
    orgId: opts.orgId,
    viewerId: opts.viewerId,
    publicOnly: opts.publicOnly,
    limit: WORKSPACE_SEARCH_ARTIFACT_CAP,
  })
  // Lower than searchArtifactVersion's own inner CONCURRENCY=8 (bundle-page
  // batching) on purpose: this outer batch and that inner one aren't composed —
  // if several of the artifacts landing in one outer batch are themselves bundles,
  // each independently opens its own 8-wide inner fan-out, so peak concurrent blob
  // reads is the PRODUCT of the two, not either alone. 4×8=32 keeps that worst case
  // reasonable without adding a cross-cutting semaphore for a bound this small.
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
    return total ? { short_id: a.short_id, title: a.title ?? a.short_id, groups, total } : null
  }
  const results: WorkspaceSearchResult[] = []
  for (let i = 0; i < arts.length; i += CONCURRENCY) {
    const batch = await Promise.all(arts.slice(i, i + CONCURRENCY).map(scanArtifact))
    for (const r of batch) if (r) results.push(r)
  }
  // A count of ALL artifacts in the org (not viewer-scoped) would over-report here
  // for anyone who can't see everything — a full page back from listArtifacts
  // (itself already viewer-scoped) is the honest signal that more MIGHT exist,
  // without a second query or a leaked total.
  const note =
    arts.length === WORKSPACE_SEARCH_ARTIFACT_CAP
      ? `scanned the ${WORKSPACE_SEARCH_ARTIFACT_CAP} most recently created artifacts you can see — there may be more`
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
  const grandTotal = results.reduce((sum, r) => sum + r.total, 0)
  if (grandTotal === 0)
    return `No matches for "${query}" in ${where} across the workspace${note ? ` (${note})` : ""}.${
      where === "source" ? " Try in:'text' to search the visible text." : ""
    }`
  const head = `${grandTotal} match${grandTotal === 1 ? "" : "es"} for "${query}" in ${where} across ${
    results.length
  } artifact${results.length === 1 ? "" : "s"}${note ? ` (${note})` : ""}`
  const body = results
    .map((r) => `## ${r.short_id} — ${r.title}\n${renderGroups(r.groups)}`)
    .join("\n\n")
  const fmt = where === "text" ? "text" : "html"
  const steer = `\n\nOpen one with search(short_id:"...", query:"${query}") for full context, or read(short_id:"...", lines:"from-to", format:"${fmt}").`
  return clip(`${head}\n\n${body}${steer}`)
}

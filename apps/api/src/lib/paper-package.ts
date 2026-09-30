// An imported paper, packaged for a reader. A paper imported from arXiv is stored as a
// read-only Context whose one artifact IS the paper; `read` of its ctx_ id loads this package:
// a summary computed from the paper (who wrote it, what it is about, how to cite it) inline,
// and the paper and its implementation analysis as pointers to read by short id.
import {
  type AnalysisCounts,
  type ArtifactRecord,
  arxivAbsUrl,
  type BlobStore,
  type ContextRecord,
  type MetaStore,
} from "@derive/core"
import { abstractOf, paperSummary } from "./arxiv-paper"
import { manifestOf } from "./bundle"
import { paperCitation } from "./latex-bundle"
import { paperAnalysisState } from "./paper-analysis"

/** A document the manifest binds (an imported paper): a pointer, read by short id. */
export interface PackagedDocument {
  short_id: string
  title: string | null
  kind: ArtifactRecord["kind"] | null
  role: string | null
}

/** Where an imported Context came from and how far its fetch got. */
export interface PackagedImport {
  source: "arxiv"
  ref: string
  url: string
  /** The paper version arXiv resolved the reference to; null until it is fetched. */
  version: number | null
  status: "pending" | "fetching" | "ready" | "failed" | "dead"
  error: { code: string; detail: string | null } | null
  /** The paper's implementation, when one is attached: the repository's page, whether its
   *  files are there to read, and the commit they were fetched at when the host said. */
  code: { url: string; status: "pending" | "ready" | "failed"; commit: string | null } | null
  /** The implementation analysis an agent published for the paper, when there is one: read it
   *  by short id before mapping the paper to its code yourself. A read of the Context adds
   *  `stale` (made against an arXiv version or commit the Context no longer holds) and counts. */
  analysis: { short_id: string; version: number; stale?: boolean; counts?: AnalysisCounts } | null
}

export interface PaperPackage {
  context: { id: string; name: string; ask_policy: ContextRecord["ask_policy"] }
  /** The summary computed from the paper; null while it cannot be read yet. */
  manifest: { short_id: string; title: string | null; version: number; content: string } | null
  /** The paper, and the analysis an agent published of it. */
  documents: PackagedDocument[]
  import: PackagedImport
}

/** The paper's own BibTeX entry, from the bundle version in hand. */
const paperCitationOf = async (
  blobs: BlobStore,
  v: NonNullable<Awaited<ReturnType<MetaStore["getVersion"]>>>,
) => {
  const manifest = await manifestOf(blobs, v)
  return manifest ? paperCitation(blobs, manifest) : null
}

/** The import block for a context row, from its job; null for a Context that was not imported. */
const importStateOf = async (meta: MetaStore, x: ContextRecord): Promise<PackagedImport | null> => {
  if (x.import_source !== "arxiv" || !x.import_ref) return null
  const [job, analysis] = await Promise.all([
    meta.getImportJobForContext(x.id).catch(() => null),
    x.analysis_artifact_id
      ? meta.getArtifactById(x.analysis_artifact_id).catch(() => null)
      : Promise.resolve(null),
  ])
  return {
    source: "arxiv",
    ref: x.import_ref,
    url: arxivAbsUrl(x.import_ref),
    version: job?.resolved_version ?? null,
    // A context whose job is gone (an older row, a sweep) reads as ready: the manifest
    // says what it holds either way.
    status: job?.status ?? "ready",
    error:
      job?.error_code && job.status !== "ready"
        ? { code: job.error_code, detail: job.error_detail }
        : null,
    code: x.code_url
      ? {
          url: x.code_url,
          status: job?.code_status ?? "pending",
          commit: job?.code_status === "ready" ? job.code_commit : null,
        }
      : null,
    analysis: analysis ? { short_id: analysis.short_id, version: analysis.current_version } : null,
  }
}

/** Assemble the package a reader loads, or null when the Context was not imported. */
export const assemblePaperPackage = async (
  meta: MetaStore,
  blobs: BlobStore,
  x: ContextRecord,
  paper: ArtifactRecord | null,
  sourceText: (
    v: NonNullable<Awaited<ReturnType<MetaStore["getVersion"]>>>,
  ) => Promise<string | null>,
): Promise<PaperPackage | null> => {
  const imported = await importStateOf(meta, x)
  if (!imported) return null
  const base: PaperPackage = {
    context: { id: x.id, name: x.name, ask_policy: x.ask_policy },
    manifest: null,
    documents: [],
    import: imported,
  }
  if (!paper) return base
  // Best-effort: a paper that will not load must not turn a read into an error. The identity
  // and the pointers are still worth having, and `manifest` comes back null.
  const v = await meta.getVersion(paper.id, paper.current_version).catch(() => null)
  const raw = v ? ((await sourceText(v).catch(() => null)) ?? "") : ""
  if (!raw) return base
  const citation = v ? await paperCitationOf(blobs, v).catch(() => null) : null
  base.documents = [
    { short_id: paper.short_id, title: paper.title, kind: paper.kind, role: "paper" },
  ]
  // The implementation analysis, when an agent published one: the second document, read
  // before mapping the paper to its code again, with whether it still describes the Context.
  if (imported.analysis) {
    const job = await meta.getImportJobForContext(x.id).catch(() => null)
    const state = await paperAnalysisState(meta, blobs, x, job).catch(() => null)
    if (state?.artifact && state.counts) {
      base.documents.push({
        short_id: state.artifact.short_id,
        title: state.artifact.title,
        kind: state.artifact.kind,
        role: "analysis",
      })
      imported.analysis = {
        short_id: state.artifact.short_id,
        version: state.artifact.current_version,
        stale: state.state === "stale",
        counts: state.counts,
      }
    }
  }
  base.manifest = {
    short_id: paper.short_id,
    title: paper.title,
    version: paper.current_version,
    content: paperSummary({
      ref: imported.ref,
      title: paper.title ?? imported.ref,
      authors: v?.author ?? null,
      version: imported.version,
      abstract: abstractOf(raw),
      bibtex: citation?.bibtex ?? null,
    }),
  }
  return base
}

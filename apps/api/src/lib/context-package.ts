// A context is a PACKAGE, not only a session partner: a manifest, the skills that
// manifest's frontmatter pins, and its bound sources. `use` gives that package work;
// `read` LOADS it. Both reach this one assembly, so what a caller loads is what a run
// materializes — the two modes cannot drift into describing different things.
//
// PROGRESSIVE OPENING is the whole shape. The manifest comes back INLINE, because it is
// the small always-read layer: the thing that orients you. Skills and sources come back
// as POINTERS you follow only when a task needs them. A package that inlined its corpus
// would spend the caller's orientation budget on orientation, which is exactly the
// failure this avoids — and the reason `checkpoint` states the same rule for itself
// ("an index a cold session follows, not a container").
import {
  type ArtifactRecord,
  arxivAbsUrl,
  type BlobStore,
  type ContextRecord,
  type MetaStore,
} from "@derive/core"
import { abstractOf, paperSummary } from "./arxiv-paper"
import { parseConnectionIds } from "./broker"
import { manifestOf } from "./bundle"
import { paperCitation } from "./latex-bundle"
import { parseManifestSkillPins, stalePins } from "./manifest-pins"

/** How much manifest text loads inline. A manifest is meant to be the small layer; one
 *  that runs past this is over budget by its own design, so the read clips and says so
 *  rather than quietly blowing the caller's context. */
export const MANIFEST_INLINE_MAX = 24_000

export interface PackagedSkill {
  short_id: string
  title: string | null
  /** The version the manifest pins; null = unpinned (a run fetches current). */
  pinned_version: number | null
  current_version: number | null
  /** The pin trails the artifact — a run executes the pinned version, not the latest. */
  stale: boolean
}

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
}

export interface ContextPackage {
  context: {
    id: string
    name: string
    ask_policy: ContextRecord["ask_policy"]
    /** Whether a RUNNER is polling. Only affects `use`; reading never needs one. */
    online: boolean
  }
  manifest: {
    short_id: string
    title: string | null
    version: number
    content: string
    clipped?: true
  } | null
  skills: PackagedSkill[]
  sources: string[]
  /** Documents the manifest binds; an imported paper's bundle is one. */
  documents: PackagedDocument[]
  /** Set when the Context was imported (a paper from arXiv): read-only, no runs. */
  import: PackagedImport | null
}

/** The paper's own BibTeX entry, from the bundle version in hand. */
const paperCitationOf = async (
  blobs: BlobStore,
  v: NonNullable<Awaited<ReturnType<MetaStore["getVersion"]>>>,
) => {
  const manifest = await manifestOf(blobs, v)
  return manifest ? paperCitation(blobs, manifest) : null
}

/** The one answer every run-shaped surface gives an imported Context. */
export const IMPORTED_NO_RUNS = (id: string): string =>
  `This Context is an imported paper. Read it with read("${id}"); it takes no runs.`

/** The import block for a context row, from its job; null for a defined Context. */
export const importStateOf = async (
  meta: MetaStore,
  x: ContextRecord,
): Promise<PackagedImport | null> => {
  if (x.import_source !== "arxiv" || !x.import_ref) return null
  const job = await meta.getImportJobForContext(x.id).catch(() => null)
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
  }
}

/** Assemble the package a caller loads. `sourceText` is the store's version-body reader,
 *  passed in so this module stays free of the MCP tool context and is directly testable. */
export const assembleContextPackage = async (
  meta: MetaStore,
  x: ContextRecord,
  manifestArtifact: ArtifactRecord | null,
  sourceText: (
    v: NonNullable<Awaited<ReturnType<MetaStore["getVersion"]>>>,
  ) => Promise<string | null>,
  online: boolean,
  /** Needed only to read an imported paper's citation file; omit elsewhere. */
  blobs?: BlobStore,
): Promise<ContextPackage> => {
  const base: ContextPackage = {
    context: { id: x.id, name: x.name, ask_policy: x.ask_policy, online },
    manifest: null,
    skills: [],
    sources: parseConnectionIds(x.connection_ids),
    documents: [],
    import: await importStateOf(meta, x),
  }
  if (!manifestArtifact) return base

  // Best-effort, mirroring the runner: a manifest that will not load must not turn a
  // read into an error — the identity and the pointers are still worth having, and a
  // caller can tell the difference because `manifest` comes back null.
  const v = await meta
    .getVersion(manifestArtifact.id, manifestArtifact.current_version)
    .catch(() => null)
  const raw = v ? ((await sourceText(v).catch(() => null)) ?? "") : ""
  if (!raw) return base

  // An imported Context IS its paper: one artifact, no manifest written beside it. What a
  // read inlines is a summary computed from the paper right here (who wrote it, what it
  // is about, how to cite it) rather than its LaTeX, which a caller reads by short id,
  // section by section, when it actually needs the text.
  if (base.import) {
    const citation = blobs && v ? await paperCitationOf(blobs, v).catch(() => null) : null
    base.documents = [
      {
        short_id: manifestArtifact.short_id,
        title: manifestArtifact.title,
        kind: manifestArtifact.kind,
        role: "paper",
      },
    ]
    base.manifest = {
      short_id: manifestArtifact.short_id,
      title: manifestArtifact.title,
      version: manifestArtifact.current_version,
      content: paperSummary({
        ref: base.import.ref,
        title: manifestArtifact.title ?? base.import.ref,
        authors: v?.author ?? null,
        version: base.import.version,
        abstract: abstractOf(raw),
        bibtex: citation?.bibtex ?? null,
      }),
    }
    return base
  }

  const clipped = raw.length > MANIFEST_INLINE_MAX
  base.manifest = {
    short_id: manifestArtifact.short_id,
    title: manifestArtifact.title,
    version: manifestArtifact.current_version,
    content: clipped ? raw.slice(0, MANIFEST_INLINE_MAX) : raw,
    ...(clipped ? { clipped: true as const } : {}),
  }

  // The SAME pin parsing the runner uses (manifest-pins), so the skills a reader is told
  // about are the skills a run would materialize — including the staleness, which is the
  // one thing a pinned-skill model gets silently wrong.
  const pins = parseManifestSkillPins(raw)
  if (!pins.length) return base
  const stale = new Set((await stalePins(meta, pins)).map((p) => p.short_id))
  base.skills = await Promise.all(
    pins.map(async (p) => {
      const a = await meta.getByShortId(p.id).catch(() => null)
      return {
        short_id: p.id,
        title: a?.title ?? null,
        pinned_version: p.version,
        current_version: a?.current_version ?? null,
        stale: stale.has(p.id),
      }
    }),
  )
  return base
}

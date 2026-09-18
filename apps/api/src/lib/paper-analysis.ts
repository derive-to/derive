// A paper's implementation analysis, as the API publishes and reads it.
//
// The analysis is its own artifact, linked to the imported paper's Context, so it keeps a
// version history, comments and access of its own while the paper stays locked. An agent
// publishes it over MCP, and this module is what makes that publish trustworthy. Before
// anything is written it checks the analysis against what it claims to describe: the Context,
// the paper version and commit it was made against, every code path, line range and symbol it
// names, and every section of the paper it cites. Derive then writes the page a person reads
// from the data, so the two cannot drift, and links the analysis with a conditional update, so
// two agents publishing at once cannot both become it.

import {
  type AnalysisCodeRef,
  type AnalysisCounts,
  type ArtifactRecord,
  analysisCodeRefs,
  analysisCounts,
  analysisPaperRefs,
  analysisStaleness,
  artifactUrl,
  type BlobStore,
  type BundleManifest,
  type ContextRecord,
  codeRefUrl,
  droppedIds,
  type ImportJobRecord,
  isCodePath,
  type MetaStore,
  PAPER_ANALYSIS_FILE,
  PAPER_ANALYSIS_PAGE,
  type PaperAnalysis,
  parseGitmodules,
  parsePaperAnalysis,
  parseRepoRef,
  type RepoRef,
  type RepoSubmodule,
  renderPaperAnalysisMarkdown,
  repoRefAt,
  type SearchIndex,
  sectionOf,
  serializePaperAnalysis,
  type VersionRecord,
} from "@derive/core"
import { cleanPath, manifestOf } from "./bundle"
import { deleteArtifactAndUnindex } from "./search"

const ANALYSIS_PATH = cleanPath(PAPER_ANALYSIS_FILE)
/** A code file is read to check a line range or symbol only up to this, at most this many at
 *  once, and within this much in all: a publish request runs in the same small isolate as any
 *  other, and a reference past these is still checked for its path. */
const CONTENT_FILE_BYTES = 2 * 1024 * 1024
const CONTENT_TOTAL_BYTES = 32 * 1024 * 1024
const CONTENT_READS_AT_ONCE = 4
/** The paper's own pages read to check sections and labels. A paper has a handful. */
const PAPER_PAGES_READ = 25
const PROBLEMS_SHOWN = 20

const fileOf = (manifest: BundleManifest, path: string) =>
  manifest.files[`/${path}`] ?? manifest.files[path]

const problems = (lead: string, list: string[]): string => {
  const shown = list.slice(0, PROBLEMS_SHOWN)
  const more = list.length - shown.length
  return `${lead}:\n${shown.map((p) => `- ${p}`).join("\n")}${more > 0 ? `\n- and ${more} more` : ""}\nFix these and publish again.`
}

/** The Context an artifact is the implementation analysis of, when it is one. */
export const analysisContextOf = async (
  meta: Pick<MetaStore, "listContextsForArtifact">,
  artifact: ArtifactRecord,
): Promise<ContextRecord | null> =>
  artifact.kind !== "bundle"
    ? null
    : ((await meta.listContextsForArtifact(artifact.id)).find(
        (x) => x.analysis_artifact_id === artifact.id,
      ) ?? null)

/** The analysis an artifact holds now, parsed; null when it holds none that reads. */
export const readAnalysis = async (
  meta: Pick<MetaStore, "getVersion">,
  blobs: BlobStore,
  artifact: ArtifactRecord,
): Promise<{ analysis: PaperAnalysis; version: VersionRecord } | null> => {
  const version = await meta.getVersion(artifact.id, artifact.current_version)
  const manifest = version ? await manifestOf(blobs, version) : null
  const file = manifest ? fileOf(manifest, ANALYSIS_PATH) : undefined
  const bytes = file ? await blobs.get(file.key) : null
  if (!version || !bytes) return null
  const parsed = parsePaperAnalysis(new TextDecoder().decode(bytes))
  return parsed.ok ? { analysis: parsed.analysis, version } : null
}

/** The implementation's repository and its submodules, to link a code reference to its host.
 *  Submodules come from the root `.gitmodules`, resolved the way the fetch resolved them. */
const implementationRefs = async (
  blobs: BlobStore,
  manifest: BundleManifest,
  codeUrl: string | null,
): Promise<{ root: RepoRef | null; submodules: RepoSubmodule[] }> => {
  const root = codeUrl ? parseRepoRef(codeUrl) : null
  if (!root) return { root: null, submodules: [] }
  const file = fileOf(manifest, "code/.gitmodules")
  const bytes = file ? await blobs.get(file.key) : null
  const submodules = bytes
    ? parseGitmodules(new TextDecoder().decode(bytes), root).flatMap((s) => {
        const declared = parseRepoRef(s.url)
        const ref = declared ? (repoRefAt(declared, s.branch) ?? declared) : null
        return ref ? [{ path: s.path, ref }] : []
      })
    : []
  return { root, submodules }
}

/** Where each reference of an analysis opens for a person: the code on its host at the
 *  commit that was fetched, and the paper on Derive. */
export const analysisLinkerFor = async (
  deps: { blobs: BlobStore; baseUrl: string },
  paper: ArtifactRecord,
  manifest: BundleManifest,
  x: ContextRecord,
  commit: string | null,
) => {
  const impl = await implementationRefs(deps.blobs, manifest, x.code_url)
  return {
    code: (ref: AnalysisCodeRef) =>
      impl.root ? codeRefUrl(impl.root, commit, impl.submodules, ref.path, ref.lines) : null,
    paper: () => artifactUrl(deps.baseUrl, paper),
  }
}

/** Every code path exists, every line range fits and every symbol appears in it; every paper
 *  section resolves the way `read` resolves it, and every label is a `\label` of the paper. */
const checkReferences = async (
  blobs: BlobStore,
  manifest: BundleManifest,
  a: PaperAnalysis,
): Promise<string[]> => {
  const out: string[] = []

  const byPath = new Map<string, { where: string; ref: AnalysisCodeRef }[]>()
  for (const r of analysisCodeRefs(a)) {
    if (!fileOf(manifest, `code/${r.ref.path}`)) {
      out.push(`${r.where}.path "${r.ref.path}" is not a file of the implementation`)
      continue
    }
    if (r.ref.lines || r.ref.symbol) byPath.set(r.ref.path, [...(byPath.get(r.ref.path) ?? []), r])
  }
  let budget = CONTENT_TOTAL_BYTES
  const readable = [...byPath.keys()].filter((path) => {
    const size = fileOf(manifest, `code/${path}`)?.size
    if (size === undefined || size > CONTENT_FILE_BYTES || size > budget) return false
    budget -= size
    return true
  })
  for (let i = 0; i < readable.length; i += CONTENT_READS_AT_ONCE) {
    await Promise.all(
      readable.slice(i, i + CONTENT_READS_AT_ONCE).map(async (path) => {
        const file = fileOf(manifest, `code/${path}`)
        const bytes = file ? await blobs.get(file.key) : null
        if (!bytes) return
        const lines = new TextDecoder().decode(bytes).split("\n")
        for (const { where, ref } of byPath.get(path) ?? []) {
          let window = lines
          if (ref.lines) {
            const [from = 1, to = from] = ref.lines.split("-").map(Number)
            if (to > lines.length) {
              out.push(
                `${where}.lines ${ref.lines} run past the end of ${path}, which has ${lines.length} lines`,
              )
              continue
            }
            window = lines.slice(from - 1, to)
          }
          if (ref.symbol && !window.join("\n").includes(ref.symbol))
            out.push(
              `${where}.symbol "${ref.symbol}" does not appear in ${path}${ref.lines ? ` at lines ${ref.lines}` : ""}`,
            )
        }
      }),
    )
  }

  const paperRefs = analysisPaperRefs(a)
  const pageOf = (section: string) => {
    const hash = section.lastIndexOf("#")
    return hash > 0 ? section.slice(0, hash) : section
  }
  const texPages = Object.keys(manifest.files)
    .map(cleanPath)
    .filter((p) => /\.(tex|latex)$/i.test(p) && !isCodePath(`/${p}`))
  const pages = [...new Set([...paperRefs.map((r) => pageOf(r.ref.section)), ...texPages])]
    .filter((p) => !isCodePath(`/${p}`) && fileOf(manifest, p))
    .slice(0, PAPER_PAGES_READ)
  const texts = new Map<string, { text: string; type: string }>()
  await Promise.all(
    pages.map(async (page) => {
      const file = fileOf(manifest, page)
      const bytes = file ? await blobs.get(file.key) : null
      if (file && bytes) texts.set(page, { text: new TextDecoder().decode(bytes), type: file.type })
    }),
  )
  for (const { where, ref } of paperRefs) {
    const page = pageOf(ref.section)
    const slug = page === ref.section ? null : ref.section.slice(page.length + 1)
    const doc = texts.get(page)
    if (!doc) {
      out.push(`${where}.section "${ref.section}" names no page of the paper`)
      continue
    }
    if (slug && sectionOf(doc.text, doc.type, slug) === null)
      out.push(
        `${where}.section "${ref.section}" names no section of ${page}: the paper's outline lists its slugs`,
      )
    if (ref.label && ![...texts.values()].some((t) => t.text.includes(`\\label{${ref.label}}`)))
      out.push(`${where}.label "${ref.label}" is not a \\label of the paper`)
  }
  return out
}

export interface PrepareAnalysisDeps {
  meta: MetaStore
  blobs: BlobStore
  baseUrl: string
  canUserAskContext: (userId: string, x: ContextRecord) => Promise<boolean>
  /** Whether this caller can reach the paper itself. */
  canReachPaper: (paper: ArtifactRecord) => Promise<boolean>
}

export interface PrepareAnalysisInput {
  files: Record<string, string>
  /** The artifact this revises, when it revises one. */
  existing: ArtifactRecord | null
  /** The Context `existing` is the analysis of, when it is one. */
  linked: ContextRecord | null
  /** The person the agent acts for. */
  userId: string | null
  /** The workspace a new analysis would be created in. */
  targetOrg: string
  message: string | undefined
  merge: boolean | undefined
  /** Publish fields the caller set that an analysis takes from its paper instead. */
  refused: string[]
}

export interface PreparedAnalysis {
  /** What to publish: the analysis in its canonical form, and the page Derive wrote from it. */
  files: Record<string, string>
  title: string
  context: ContextRecord
  paper: ArtifactRecord
  /** What the Context's analysis link holds now: a new analysis links only while it still does. */
  expected: string | null
  /** The version an update was read from, null when creating one. The publish appends only
   *  while the analysis is still at it, so a concurrent update is refused, not buried. */
  basedOn: number | null
  access: {
    workspaceAccess: ArtifactRecord["workspace_access"]
    linkRole: "none"
    listed: "none"
  }
}

/**
 * Check an analysis a caller is about to publish and turn it into the bundle Derive stores.
 * Nothing is written here: an analysis that does not hold comes back as one error listing every
 * problem, so a single revision can fix them all.
 */
export const preparePaperAnalysis = async (
  deps: PrepareAnalysisDeps,
  input: PrepareAnalysisInput,
): Promise<PreparedAnalysis | { error: string }> => {
  const source = input.files[PAPER_ANALYSIS_FILE] ?? input.files[ANALYSIS_PATH]
  if (source === undefined)
    return {
      error: `This is an implementation analysis: publish it whole, as \`files: {"${ANALYSIS_PATH}": "<the JSON>"}\`.`,
    }
  const others = Object.keys(input.files)
    .map(cleanPath)
    .filter((p) => p !== ANALYSIS_PATH)
  if (others.length > 0)
    return {
      error: `An implementation analysis is one file, ${ANALYSIS_PATH}; Derive writes the page people read from it. Leave out ${others.map((p) => `\`${p}\``).join(", ")}.`,
    }
  if (input.merge)
    return {
      error: "An implementation analysis is published whole, never merged: pass the complete JSON.",
    }
  if (input.refused.length > 0)
    return {
      error: `Derive gives an implementation analysis the access of its paper: leave out ${input.refused.map((f) => `\`${f}\``).join(", ")}.`,
    }
  const parsed = parsePaperAnalysis(source)
  if (!parsed.ok) return { error: problems("The analysis does not validate", parsed.errors) }
  const a = parsed.analysis
  if (!input.userId)
    return {
      error:
        "An implementation analysis is published on a person's behalf: reconnect with an OAuth login so Derive knows whose agent wrote it.",
    }

  const x = await deps.meta.getContext(a.context)
  if (!x || x.import_source !== "arxiv" || !(await deps.canUserAskContext(input.userId, x)))
    return {
      error: `No imported paper "${a.context}" you can reach. \`context\` is the id of the paper's Context (ctx_…).`,
    }
  if (input.linked && input.linked.id !== x.id)
    return { error: `This is the analysis of ${input.linked.id}; its \`context\` cannot change.` }
  if (x.org_id !== (input.existing?.org_id ?? input.targetOrg))
    return {
      error: `${x.id} is in another workspace: publish its analysis there, with \`workspace\`.`,
    }
  const [job, paper] = await Promise.all([
    deps.meta.getImportJobForContext(x.id),
    deps.meta.getArtifactById(x.manifest_artifact_id),
  ])
  if (!paper || !(await deps.canReachPaper(paper)))
    return { error: `The paper of ${x.id} is not one you can reach.` }
  const root = x.code_url ? parseRepoRef(x.code_url) : null
  if (!root || job?.code_status !== "ready")
    return {
      error:
        "This paper has no implementation ready to analyse. Attach its repository on the Context's page, and publish once the code has arrived.",
    }

  // One analysis per Context: a second is an update to the first.
  const current = x.analysis_artifact_id
    ? await deps.meta.getArtifactById(x.analysis_artifact_id)
    : null
  if (input.existing && input.existing.id !== x.analysis_artifact_id)
    return {
      error: `"${input.existing.short_id}" is not the analysis of ${x.id}. Create the analysis as a new artifact: publish without \`short_id\`.`,
    }
  if (!input.existing && current)
    return {
      error: `${x.id} already has an implementation analysis, ${current.short_id}. Update that one: read it, then publish({ short_id: "${current.short_id}", files: { "${ANALYSIS_PATH}": … } }) with \`based_on\` ${current.current_version} and a \`message\`.`,
    }

  const mismatches: string[] = []
  if (a.paper.short_id !== paper.short_id)
    mismatches.push(`analysis.paper.short_id must be "${paper.short_id}", the paper of ${x.id}`)
  if (a.paper.arxiv_version !== (job.resolved_version ?? null))
    mismatches.push(
      `analysis.paper.arxiv_version must be ${job.resolved_version ?? null}, the version the Context imported`,
    )
  // The repository in any form a link takes, stored the way the Context names it.
  if (parseRepoRef(a.implementation.repository)?.canonical !== root.canonical)
    mismatches.push(`analysis.implementation.repository must be "${root.canonical}"`)
  else a.implementation.repository = root.canonical
  if (a.implementation.commit !== (job.code_commit ?? null))
    mismatches.push(
      `analysis.implementation.commit must be ${job.code_commit ? `"${job.code_commit}"` : "null"}, the commit the Context fetched`,
    )
  if (input.existing) {
    if (a.based_on !== input.existing.current_version)
      mismatches.push(
        `analysis.based_on must be ${input.existing.current_version}, the version you read; if yours is older, read it again first`,
      )
    if (!input.message?.trim())
      mismatches.push("an update needs a `message` saying what changed and why")
    const previous = await readAnalysis(deps.meta, deps.blobs, input.existing)
    const dropped = previous ? droppedIds(previous.analysis, a) : []
    if (dropped.length > 0)
      mismatches.push(
        `${dropped.map((id) => `"${id}"`).join(", ")} ${dropped.length === 1 ? "is" : "are"} gone without a reason: keep ${dropped.length === 1 ? "it" : "them"}, or list ${dropped.length === 1 ? "it" : "them"} in \`removed\` with why`,
      )
  } else if (a.based_on !== null) {
    mismatches.push("analysis.based_on must be null when creating the analysis")
  }

  const version = await deps.meta.getVersion(paper.id, paper.current_version)
  const manifest = version ? await manifestOf(deps.blobs, version) : null
  if (!manifest)
    return {
      error: "The paper could not be read back to check the analysis against it. Try again.",
    }
  const all = [...mismatches, ...(await checkReferences(deps.blobs, manifest, a))]
  if (all.length > 0)
    return { error: problems("The analysis does not match what it describes", all) }

  const links = await analysisLinkerFor(deps, paper, manifest, x, job.code_commit)
  const paperTitle = paper.title ?? `arXiv:${x.import_ref}`
  return {
    files: {
      [ANALYSIS_PATH]: serializePaperAnalysis(a),
      [cleanPath(PAPER_ANALYSIS_PAGE)]: renderPaperAnalysisMarkdown(a, { paperTitle, links }),
    },
    title: `${paperTitle}: implementation analysis`.slice(0, 200),
    context: x,
    paper,
    expected: x.analysis_artifact_id,
    basedOn: input.existing ? a.based_on : null,
    access: { workspaceAccess: paper.workspace_access, linkRole: "none", listed: "none" },
  }
}

/** Link a newly published analysis to its Context. When another agent linked one first, the
 *  new artifact is deleted before anyone hears of it, and the error names the one that won. */
export const linkPaperAnalysis = async (
  deps: { meta: MetaStore; search?: SearchIndex },
  prepared: PreparedAnalysis,
  artifact: ArtifactRecord,
): Promise<string | null> => {
  if (await deps.meta.setContextAnalysis(prepared.context.id, artifact.id, prepared.expected))
    return null
  await deleteArtifactAndUnindex(deps.meta, deps.search, artifact.id, artifact.org_id)
  const now = await deps.meta.getContext(prepared.context.id)
  const winner = now?.analysis_artifact_id
    ? await deps.meta.getArtifactById(now.analysis_artifact_id)
    : null
  return `Another agent published this paper's implementation analysis first${winner ? ` (${winner.short_id})` : ""}. Nothing was created: read that one and update it.`
}

export interface PaperAnalysisState {
  /** unavailable: no implementation ready to analyse and no analysis; none: ready for one;
   *  ready: an analysis describes what the Context holds; stale: it describes what it held. */
  state: "unavailable" | "none" | "ready" | "stale"
  artifact: ArtifactRecord | null
  analysis: PaperAnalysis | null
  version: VersionRecord | null
  staleReasons: string[]
  counts: AnalysisCounts | null
}

/** Where an imported paper's implementation analysis stands, for everything that shows it. */
export const paperAnalysisState = async (
  meta: MetaStore,
  blobs: BlobStore,
  x: ContextRecord,
  job: ImportJobRecord | null,
): Promise<PaperAnalysisState> => {
  const codeReady = x.import_source === "arxiv" && !!x.code_url && job?.code_status === "ready"
  const artifact = x.analysis_artifact_id
    ? await meta.getArtifactById(x.analysis_artifact_id)
    : null
  const read = artifact ? await readAnalysis(meta, blobs, artifact) : null
  if (!artifact || !read)
    return {
      state: codeReady ? "none" : "unavailable",
      artifact: null,
      analysis: null,
      version: null,
      staleReasons: [],
      counts: null,
    }
  const root = x.code_url ? parseRepoRef(x.code_url) : null
  const staleReasons = analysisStaleness(read.analysis, {
    arxivVersion: job?.resolved_version ?? null,
    repository: root?.canonical ?? null,
    commit: codeReady ? (job?.code_commit ?? null) : null,
  })
  return {
    state: staleReasons.length > 0 ? "stale" : "ready",
    artifact,
    analysis: read.analysis,
    version: read.version,
    staleReasons,
    counts: analysisCounts(read.analysis),
  }
}

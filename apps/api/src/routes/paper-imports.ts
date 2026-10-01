import {
  type AnalysisCodeRef,
  type AnalysisPaperRef,
  type ArtifactRecord,
  analysisCounts,
  analysisPaperRefs,
  arxivAbsUrl,
  type BundleManifest,
  type ContextRecord,
  type ImportJobRecord,
  newId,
  outlineOf,
  type PaperAnalysis,
  paperAnalysisStartPrompt,
  paperAnalysisUpdatePrompt,
  parseArxivRef,
  parseRepoRef,
  publish,
  repoWebUrl,
} from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { bylineOf, fetchingPaper } from "../lib/arxiv-paper"
import { parseConnectionIds } from "../lib/broker"
import { manifestOf } from "../lib/bundle"
import { mintToken, sha256 } from "../lib/crypto"
import { bail, fail, readJson } from "../lib/http"
import { paperCitation } from "../lib/latex-bundle"
import { analysisLinkerFor, paperAnalysisState } from "../lib/paper-analysis"
import { deleteArtifactAndUnindex } from "../lib/search"

/**
 * Papers imported from arXiv. An imported paper is stored as a read-only Context whose one
 * artifact IS the paper (its LaTeX bundle, fetched by the importer in imports.ts), plus an
 * optional implementation repository and the analysis an agent publishes of it.
 *
 * These are the only Context routes left after the agents cutover: askable Contexts, their
 * sessions and runtimes are gone, and every route here refuses a Context that was not
 * imported. The paths keep their /v1/contexts prefix so existing clients keep working.
 */
export const paperImportRoutes = (ctx: AppContext) => {
  const {
    meta,
    activeWorkspace,
    authorize,
    billingGate,
    canAskContext,
    deps,
    limited,
    managementPrincipal,
    overStorage,
    publishLimiter,
    requireWorkspace,
    workspaceCan,
  } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  /** An imported Context its creator or a workspace manager may change, never a runner. */
  const manageableImport = async (c: Context): Promise<ContextRecord | Response> => {
    const userId = await managementPrincipal(c)
    if (!userId) return fail(c, 401, "unauthenticated")
    const x = await meta.getContext(c.req.param("id") ?? "")
    if (!x || !x.import_source || x.org_id !== (await activeWorkspace(c)))
      return fail(c, 404, "not found")
    if (x.created_by !== userId && !(await workspaceCan(c, "manage")))
      return fail(c, 403, "forbidden")
    return x
  }

  /** The Context row an imported paper lives on. The row requires an agent, and a paper runs
   *  nothing, so it gets a hidden managed principal of its own that is never handed out;
   *  deleting the paper's artifact cascades the row away. */
  const createImportContext = async (
    paperArtifactId: string,
    orgId: string,
    userId: string,
    ref: string,
    codeRef: ReturnType<typeof parseRepoRef>,
  ): Promise<ContextRecord> => {
    const name = `arXiv:${ref}`
    const mint = (agentName: string) =>
      meta.createAgent({
        id: newId("ag"),
        org_id: orgId,
        name: agentName,
        token: sha256(mintToken("dk_agt")),
        role: "editor",
        created_by: userId,
        managed: 1,
      })
    const agent = await mint(name).catch(() => mint(`${name} ${newId("x").slice(-4)}`))
    try {
      return await meta.createContext({
        id: newId("ctx"),
        org_id: orgId,
        name,
        agent_id: agent.id,
        manifest_artifact_id: paperArtifactId,
        created_by: userId,
        max_run_ms: null,
        connection_ids: null,
        ask_policy: "workspace",
        import_source: "arxiv",
        import_ref: ref,
        code_url: codeRef ? repoWebUrl(codeRef) : null,
      })
    } catch (error) {
      await meta.deleteAgent(agent.id, orgId).catch(() => {})
      throw error
    }
  }

  const ContextImportInfo = z
    .object({
      source: z.literal("arxiv"),
      ref: z.string().describe("The bare paper id (`2401.12345`)."),
      version: z
        .number()
        .nullable()
        .describe("The paper version arXiv resolved the import to; null until fetched."),
      status: z
        .enum(["pending", "fetching", "ready", "failed", "dead"])
        .describe(
          "pending/fetching: the source is on its way; ready: the paper is published and readable; failed: a transient error, retry scheduled; dead: gave up (retry by hand, or discard).",
        ),
      error: z
        .object({ code: z.string(), detail: z.string().nullable() })
        .nullable()
        .describe("The last failure: a code the client maps to copy, plus a short detail."),
      url: z.string().describe("The paper's abstract page on arXiv."),
      imported_by: z.string(),
      code: z
        .object({
          url: z.string().describe("The repository's page on its own host."),
          status: z
            .enum(["pending", "ready", "failed"])
            .describe(
              "pending: on its way with the paper; ready: stored inside the paper's artifact, where an agent reads it; failed: see `error`. Independent of the paper's own status.",
            ),
          error: z.string().nullable().describe("Why the repository could not be fetched."),
          commit: z
            .string()
            .nullable()
            .describe(
              "The commit the repository was fetched at, when its host recorded one. Null until it is ready, and for an attachment made before commits were recorded.",
            ),
        })
        .nullable()
        .describe(
          "The public repository implementing this paper, when one is attached. Its files live inside the paper's artifact for agents to read; people open the repository on its own host.",
        ),
    })
    .openapi("ContextImportInfo")

  const ContextInfo = z
    .object({
      id: z.string(),
      name: z.string(),
      agent_id: z
        .string()
        .describe("The hidden agent made for this imported paper. It is never listed or asked."),
      manifest_short_id: z
        .string()
        .nullable()
        .describe("Short id of the linked manifest artifact; null if it can't be resolved."),
      created_by: z.string(),
      created_at: z.string(),
      runner_seen_at: z
        .string()
        .nullable()
        .describe(
          "When the runner last polled the queue (~minutely); null = never. Drives online/offline.",
        ),
      ask_policy: z
        .enum(["workspace", "invited"])
        .describe(
          "Who in the workspace may ask: any member, or the invited roster. Never outside the workspace.",
        ),
      connection_ids: z
        .array(z.string())
        .describe("Connections this context may use — its tools, in every lane it runs in."),
      description: z
        .string()
        .nullable()
        .optional()
        .describe(
          "The manifest's own first paragraph — frontmatter and a single leading heading stripped, capped. Null when the manifest has none or can't be read.",
        ),
      skills_count: z
        .number()
        .optional()
        .describe("How many skills the manifest's frontmatter pins."),
      manifest_version: z
        .number()
        .nullable()
        .optional()
        .describe("The manifest artifact's current version; null if it can't be resolved."),
      import: ContextImportInfo.nullable().describe(
        "Set when this Context was imported (a paper from arXiv): read-only, no runner, no sessions. Null for a Context someone defined.",
      ),
    })
    .openapi("ContextInfo")

  const ManifestDocumentInfo = z
    .object({
      short_id: z.string(),
      title: z.string().nullable(),
      kind: z.enum(["doc", "bundle"]).nullable(),
      role: z
        .string()
        .nullable()
        .describe(
          "What the document is to the Context: `paper`, or `analysis` for the paper's implementation analysis.",
        ),
    })
    .openapi("ManifestDocumentInfo")

  const AnalysisCodeRefInfo = z
    .object({
      path: z.string().describe("The file's path in the repository."),
      symbol: z.string().nullable(),
      lines: z.string().nullable().describe("A line, or a range such as `40-88`."),
      href: z
        .string()
        .nullable()
        .describe("The file on the repository's own host, with the lines highlighted."),
      pinned: z
        .boolean()
        .describe(
          "Whether `href` opens the exact commit the analysis read. A file inside a submodule, or an attachment with no recorded commit, opens a branch instead.",
        ),
    })
    .openapi("AnalysisCodeRef")

  const AnalysisPaperRefInfo = z
    .object({
      section: z
        .string()
        .describe("A page of the paper, or `page#slug` for one heading's part of it."),
      label: z.string().nullable(),
      heading: z.string().nullable().describe("The heading the section names, when it names one."),
    })
    .openapi("AnalysisPaperRef")

  const ContextAnalysisInfo = z
    .object({
      state: z
        .enum(["unavailable", "none", "ready", "stale", "restricted"])
        .describe(
          "unavailable: no implementation is ready to analyse; none: no analysis yet; ready: it describes what the Context holds; stale: it was made against an arXiv version or commit the Context no longer holds; restricted: one exists that the caller cannot open.",
        ),
      stale_reasons: z.array(z.string()),
      paper_short_id: z.string().nullable(),
      implementation: z
        .object({ repository: z.string(), url: z.string(), commit: z.string().nullable() })
        .nullable(),
      analysis: z
        .object({
          short_id: z.string(),
          title: z.string().nullable(),
          version: z.number(),
          updated_at: z.string(),
          agent: z.string().nullable().describe("The agent that published this version."),
          summary: z.string(),
          made_against: z.object({
            arxiv_version: z.number().nullable(),
            repository: z.string(),
            commit: z.string().nullable(),
          }),
          counts: z.object({
            contributions: z.number(),
            details: z.number(),
            implemented: z.number(),
            could_not_map: z.number(),
            unmapped: z.number(),
            open_questions: z.number(),
          }),
          contributions: z.array(
            z.object({
              id: z.string(),
              title: z.string(),
              claim: z.string(),
              paper: z.array(AnalysisPaperRefInfo),
              details: z.array(
                z.object({
                  id: z.string(),
                  title: z.string(),
                  status: z.enum(["implemented", "could_not_map"]),
                  notes: z.string().nullable(),
                  paper: z.array(AnalysisPaperRefInfo),
                  code: z.array(AnalysisCodeRefInfo),
                }),
              ),
            }),
          ),
          unmapped: z.array(
            z.object({
              id: z.string(),
              notes: z.string(),
              path: z.string(),
              symbol: z.string().nullable(),
              lines: z.string().nullable(),
              href: z.string().nullable(),
              pinned: z.boolean(),
            }),
          ),
          open_questions: z.array(z.object({ id: z.string(), question: z.string() })),
        })
        .nullable(),
      prompts: z.object({
        start: z
          .string()
          .nullable()
          .describe(
            "What a person pastes into their agent to write the analysis, while none exists.",
          ),
        update: z
          .string()
          .nullable()
          .describe(
            "What a person pastes into their agent to check and update it, once it exists.",
          ),
      }),
      can_publish: z
        .boolean()
        .describe(
          "Whether the caller's own agents may start or update it: publishing needs an editor seat or higher.",
        ),
    })
    .openapi("ContextAnalysisInfo")

  // A skill the manifest pins, with pin health: the pinned version next to the skill
  // artifact's actual current one. `parseManifestSkillPins` already does this for the
  // runner (stale = the queue's own advisory); this is the same computation, shaped for
  // a human to read on the console's Manifest tab rather than acted on by a claim.
  const ManifestSkillInfo = z
    .object({
      short_id: z.string(),
      title: z.string().nullable(),
      pinned: z.number().nullable().describe("The pinned version; null = unpinned (runs current)."),
      current: z
        .number()
        .nullable()
        .describe("The skill artifact's current version; null if it can't be resolved."),
      stale: z.boolean().describe("True when the pin trails the artifact's current version."),
    })
    .openapi("ManifestSkillInfo")

  const ManifestRepoInfo = z
    .object({ url: z.string(), ref: z.string().nullable() })
    .openapi("ManifestRepoInfo")

  const ManifestInfo = z
    .object({
      short_id: z.string(),
      title: z.string().nullable(),
      version: z.number(),
      md: z.string(),
      pushed_at: z.string().describe("When this version was published."),
    })
    .openapi("ManifestInfo")

  // The resolved Brandprint handed to the context's runner (agent branch of GET only).
  // The runner materializes skill members into its skills dir and reads notes + theme;
  // it is the runner's ONLY window into workspace conventions — a context has no other
  // config channel. Members are the workspace + owner-profile collection artifacts, deduped.
  const BrandprintConfig = z
    .object({
      profile_short_id: z
        .string()
        .nullable()
        .describe(
          "The workspace brand-profile artifact (an HTML page carrying theme tokens), when set; null otherwise. Not in `members` — it is the headline read, not a note.",
        ),
      members: z
        .array(
          z.object({
            short_id: z.string(),
            title: z.string().nullable(),
            version: z
              .number()
              .describe("The member's current version at fetch time (provenance)."),
            is_skill: z
              .boolean()
              .describe("A skill bundle (materialize into skills/) vs a prose note."),
          }),
        )
        .describe(
          "Convention artifacts: skills to materialize, notes to read. Excludes the profile.",
        ),
    })
    .openapi("BrandprintConfig")

  /** The import block of an imported context, from its job row. A context whose job is
   *  gone (an older row, a sweep) reads as ready: what the manifest holds is what it is. */
  const importJson = (x: ContextRecord, job: ImportJobRecord | null) => {
    // The job runs for two things, and after the paper is published it usually runs for
    // the second: attaching an implementation requeues it. `status` is the PAPER's, so a
    // job working on code reports the paper as what it is, which is here and readable.
    // The code's own state is `code.status`; conflating them told a person their paper
    // was being fetched from arXiv again when nothing of the sort was happening.
    const paperPublished = !!job?.paper_artifact_id
    const status =
      job && paperPublished && (job.status === "pending" || job.status === "fetching")
        ? ("ready" as const)
        : (job?.status ?? ("ready" as const))
    return x.import_source === "arxiv" && x.import_ref
      ? {
          source: "arxiv" as const,
          ref: x.import_ref,
          version: job?.resolved_version ?? null,
          status,
          error:
            job?.error_code && status !== "ready"
              ? { code: job.error_code, detail: job.error_detail }
              : null,
          url: arxivAbsUrl(x.import_ref),
          imported_by: job?.requested_by ?? x.created_by,
          code: x.code_url
            ? {
                url: x.code_url,
                // No job row (or none yet) means the fetch has not run: it is on its way.
                status: job?.code_status ?? ("pending" as const),
                error: job?.code_status === "failed" ? job.code_error : null,
                // Only what is there to read has a commit: while a replacement is on its way
                // the previous one no longer describes the link.
                commit: job?.code_status === "ready" ? job.code_commit : null,
              }
            : null,
        }
      : null
  }

  const contextJson = (
    x: ContextRecord,
    manifestShortId: string | null,
    job: ImportJobRecord | null = null,
  ) => ({
    id: x.id,
    name: x.name,
    agent_id: x.agent_id,
    manifest_short_id: manifestShortId,
    created_by: x.created_by,
    created_at: x.created_at,
    runner_seen_at: x.runner_seen_at,
    ask_policy: x.ask_policy,
    connection_ids: parseConnectionIds(x.connection_ids),
    import: importJson(x, job),
  })

  /** An imported Context is one artifact: the paper. It names itself as its document, so
   *  a reader has one short id to open and an agent has one to read. */
  const paperDocuments = (paper: ArtifactRecord) => [
    { short_id: paper.short_id, title: paper.title, kind: paper.kind, role: "paper" as string },
  ]

  /** An imported Context's documents: the paper, and the implementation analysis an agent
   *  published of it, when there is one. */
  const importedDocuments = async (x: ContextRecord, paper: ArtifactRecord) => {
    const analysis = x.analysis_artifact_id
      ? await meta.getArtifactById(x.analysis_artifact_id).catch(() => null)
      : null
    return [
      ...paperDocuments(paper),
      ...(analysis
        ? [
            {
              short_id: analysis.short_id,
              title: analysis.title,
              kind: analysis.kind,
              role: "analysis" as string,
            },
          ]
        : []),
    ]
  }

  /** The heading each cited section of the paper names, read from the paper's own pages. */
  const paperHeadings = async (
    manifest: BundleManifest,
    a: PaperAnalysis,
  ): Promise<Map<string, string>> => {
    const out = new Map<string, string>()
    const sections = new Set(
      analysisPaperRefs(a)
        .map((r) => r.ref.section)
        .filter((s) => s.lastIndexOf("#") > 0),
    )
    const pageOf = (s: string) => s.slice(0, s.lastIndexOf("#"))
    const pages = [...new Set([...sections].map(pageOf))].slice(0, 25)
    await Promise.all(
      pages.map(async (page) => {
        const file = manifest.files[`/${page}`] ?? manifest.files[page]
        const bytes = file ? await ctx.blobs.get(file.key).catch(() => null) : null
        if (!file || !bytes) return
        const outline = outlineOf(new TextDecoder().decode(bytes), file.type)
        for (const s of sections) {
          if (pageOf(s) !== page) continue
          const heading = outline.find((h) => h.slug === s.slice(page.length + 1))
          if (heading) out.set(s, heading.text)
        }
      }),
    )
    return out
  }

  /** The paper's own BibTeX entry (its bundle's CITATION.bib), for Copy BibTeX. */
  const paperBibtex = async (paper: ArtifactRecord): Promise<string | null> => {
    const v = await meta.getVersion(paper.id, paper.current_version).catch(() => null)
    const manifest = v ? await manifestOf(ctx.blobs, v) : null
    return manifest ? ((await paperCitation(ctx.blobs, manifest))?.bibtex ?? null) : null
  }

  /** The same slice for an imported Context, whose artifact is the paper: its first
   *  paragraph is LaTeX, so the row says who wrote it instead. `author` is the paper's
   *  author line, recorded on the version the import published. */
  const paperSummaryRow = (x: ContextRecord, author: string | null, version: number | null) => ({
    description: x.import_ref ? bylineOf(x.import_ref, author ? [author] : [], null) : null,
    skills_count: 0,
    manifest_version: version,
  })

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/contexts",
      tags: ["Contexts"],
      summary: "List the workspace's imported papers.",
      responses: {
        200: {
          description: "The workspace's imported papers, each with its fetch state.",
          content: { "application/json": { schema: z.object({ contexts: z.array(ContextInfo) }) } },
        },
      },
    }),
    async (c) => {
      if (!(await managementPrincipal(c))) return bail(fail(c, 401, "unauthenticated"))
      const org = await requireWorkspace(c, "read")
      if (org instanceof Response) return bail(org)
      const rows = (await meta.contextsWithManifests(org)).filter((x) => x.import_source)
      // One batched read of the import jobs, so a row can say "fetching" the moment a paper
      // is queued.
      const jobs = new Map(
        (await meta.getImportJobsForContexts(rows.map((x) => x.id))).map((j) => [j.context_id, j]),
      )
      const contexts = await Promise.all(
        rows.map(async (x) => {
          const paper = x.manifest_short_id
            ? await meta.getArtifactById(x.manifest_artifact_id).catch(() => null)
            : null
          // The paper's first paragraph is LaTeX, so its row says who wrote it, from the
          // version the import published.
          const v = paper
            ? await meta.getVersion(paper.id, paper.current_version).catch(() => null)
            : null
          return {
            ...contextJson(x, x.manifest_short_id, jobs.get(x.id) ?? null),
            ...paperSummaryRow(x, v?.author ?? null, paper?.current_version ?? null),
          }
        }),
      )
      return c.json({ contexts })
    },
  )

  // ---- import a paper from arXiv --------------------------------------------
  // The Context exists from this request on, so the list shows it "fetching" at once;
  // the worker (imports.ts) fetches the paper behind arXiv's request gate and fills it
  // in. Idempotent per paper per workspace: the same paper pasted twice opens the one
  // Context, requeuing its import if that had failed.
  const MAX_ACTIVE_IMPORTS_PER_WORKSPACE = 3
  // What an import is expected to add, for the storage gate at the paste. Deliberately not
  // the ceiling (MAX_IMPORTED_PAPER_BYTES): nearly every paper is a small fraction of it,
  // and gating on the ceiling would turn away workspaces with room for all of them.
  const ARXIV_IMPORT_ESTIMATED_BYTES = 100 * 1024 * 1024

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/contexts/import/arxiv",
      tags: ["Contexts"],
      summary:
        "Import a paper from arXiv as a read-only Context: its LaTeX source and BibTeX, fetched in the background.",
      responses: {
        201: {
          description:
            "The new Context, already listed, with import.status 'fetching' (or 'pending') until the worker publishes the paper.",
          content: { "application/json": { schema: ContextInfo } },
        },
        200: {
          description: "This workspace already imported that paper: its existing Context.",
          content: { "application/json": { schema: ContextInfo } },
        },
      },
    }),
    async (c) => {
      const owner = await managementPrincipal(c)
      if (!owner) return bail(fail(c, 401, "unauthenticated"))
      const org = await requireWorkspace(c, "publish")
      if (org instanceof Response) return bail(org)
      const b = await readJson(
        c,
        z.object({
          url: z.string().trim().min(1).max(2000),
          code_url: z.string().trim().max(2000).optional(),
        }),
      )
      if (b instanceof Response) return bail(b)
      const ref = parseArxivRef(b.url)
      if (!ref) return bail(fail(c, 400, "not an arXiv link", { code: "not_arxiv" }))
      // The optional implementation. Validated here so a bad link is a 400 on the paste
      // rather than a failure a minute later, and stored canonically so the worker and
      // the console build every URL from a parsed reference.
      const codeRef = b.code_url ? parseRepoRef(b.code_url) : null
      if (b.code_url && !codeRef)
        return bail(
          fail(c, 400, "not a public GitHub or GitLab repository", { code: "not_a_repo" }),
        )
      if (deps.imports === false)
        return bail(fail(c, 503, "paper imports are not configured on this deployment"))
      // An import is two publishes (the manifest and the paper) plus an upstream fetch,
      // so it pays every gate a publish pays, against the largest source the worker
      // would accept.
      const capped = await limited(c, publishLimiter)
      if (capped) return bail(capped)
      const blocked = await billingGate(c, org)
      if (blocked) return bail(blocked)
      // An implementation may add as much again as the paper.
      if (await overStorage(org, ARXIV_IMPORT_ESTIMATED_BYTES * (codeRef ? 2 : 1)))
        return bail(fail(c, 413, "this workspace is out of storage", { code: "storage" }))

      const existing = await meta.findContextByImport(org, "arxiv", ref.id)
      if (existing) {
        const job = await meta.getImportJobForContext(existing.id)
        if (job && (job.status === "failed" || job.status === "dead"))
          await meta.updateImportJob(job.id, {
            status: "pending",
            // Pasting the paper again is a person asking for another go, so it gets the
            // full budget. Without this a paper that had already died came back with its
            // attempts spent and gave up on the first failure, which reads as "it did not
            // even try" to whoever pasted it.
            attempts: 0,
            next_attempt_at: new Date().toISOString(),
            // No claim survives a requeue: a worker still holding one stops at its next write.
            claim_token: null,
            updated_at: new Date().toISOString(),
          })
        const manifest = await meta.getArtifactById(existing.manifest_artifact_id)
        deps.pokeImports?.()
        return c.json(
          contextJson(
            existing,
            manifest?.short_id ?? null,
            job && (await meta.getImportJob(job.id)),
          ),
          200,
        )
      }
      if ((await meta.countActiveImportJobs(org)) >= MAX_ACTIVE_IMPORTS_PER_WORKSPACE)
        return bail(fail(c, 429, "too many imports in progress; wait for one to finish"))

      // The paper's own artifact first, so a Context never exists without one, and the job
      // last, so a Context never exists without something that will fill it in. The paper
      // IS the Context's artifact: this version is a placeholder document that says the
      // fetch is on its way, and the worker republishes it as the paper itself.
      const settings = await meta.getOrgSettings(org).catch(() => null)
      const stub = await publish(meta, ctx.blobs, {
        bytes: new Uint8Array(),
        filename: `${ref.id.replace(/\//g, "_")}.zip`,
        isBundle: true,
        files: { "/main.tex": new TextEncoder().encode(fetchingPaper(ref.id)) },
        orgId: org,
        title: `arXiv:${ref.id}`,
        author: "arXiv",
        authorId: null,
        source: "api",
        message: `Importing arXiv:${ref.canonical}`,
        importSource: "arxiv",
        workspaceAccess: settings?.defaultWorkspaceAccess ?? "member",
        linkRole: "none",
        listed: "none",
      })
      // Locked from the first version: nobody edits a paper arXiv published. The worker
      // republishes it through the core, which the lock never gates (only routes do).
      await meta.setLocked(stub.artifact.id, 1)
      await meta.setArtifactMember({
        id: newId("am"),
        artifact_id: stub.artifact.id,
        user_id: owner,
        role: "owner",
      })
      let made: { context: ContextRecord }
      try {
        made = { context: await createImportContext(stub.artifact.id, org, owner, ref.id, codeRef) }
      } catch {
        await meta.deleteArtifact(stub.artifact.id, org).catch(() => undefined)
        return bail(fail(c, 409, "a context with that name already exists"))
      }
      let job: ImportJobRecord
      try {
        job = await meta.enqueueImportJob({
          id: newId("imp"),
          org_id: org,
          context_id: made.context.id,
          requested_by: owner,
          kind: "arxiv",
          ref: ref.canonical,
          scope: deps.baseUrl.replace(/\/$/, ""),
        })
      } catch (error) {
        await meta.deleteContext(made.context.id, org).catch(() => undefined)
        await meta.deleteArtifact(stub.artifact.id, org).catch(() => undefined)
        throw error
      }
      deps.pokeImports?.()
      return c.json(contextJson(made.context, stub.artifact.short_id, job), 201)
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/contexts/{id}/import/retry",
      tags: ["Contexts"],
      summary: "Queue a failed paper import again (the context's creator or a workspace manager).",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The Context, its import queued again.",
          content: { "application/json": { schema: ContextInfo } },
        },
      },
    }),
    async (c) => {
      const x = await manageableImport(c)
      if (x instanceof Response) return bail(x)
      const job = await meta.getImportJobForContext(x.id)
      if (!x.import_source || !job) return bail(fail(c, 404, "not an imported context"))
      if (job.status === "failed" || job.status === "dead") {
        const now = new Date().toISOString()
        await meta.updateImportJob(job.id, {
          status: "pending",
          next_attempt_at: now,
          lease_until: null,
          claim_token: null,
          updated_at: now,
        })
        // A retry after giving up starts the count over; the paper it may already have
        // published is kept and resumed from.
        if (job.status === "dead") await meta.updateImportJob(job.id, { attempts: 0 })
        deps.pokeImports?.()
      }
      const manifest = await meta.getArtifactById(x.manifest_artifact_id)
      return c.json(contextJson(x, manifest?.short_id ?? null, await meta.getImportJob(job.id)))
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/contexts/{id}/import/code",
      tags: ["Contexts"],
      summary:
        "Attach, replace or remove the repository implementing an imported paper (the context's creator or a workspace manager).",
      description:
        "The repository is fetched into the paper's own artifact, where an agent reading the paper reads the code beside it; people get a link to it on its own host and never a file listing. Pass `url: null` to remove it, which republishes the paper without the code.",
      request: {
        params: z.object({ id: z.string() }),
        body: {
          content: {
            "application/json": {
              schema: z.object({
                url: z
                  .string()
                  .trim()
                  .max(2000)
                  .nullable()
                  .describe("A public GitHub or GitLab repository; null removes the attachment."),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "The Context, its implementation queued (or removed).",
          content: { "application/json": { schema: ContextInfo } },
        },
      },
    }),
    async (c) => {
      const x = await manageableImport(c)
      if (x instanceof Response) return bail(x)
      const job = await meta.getImportJobForContext(x.id)
      if (!x.import_source || !job) return bail(fail(c, 404, "not an imported context"))
      const b = await readJson(c, z.object({ url: z.string().trim().max(2000).nullable() }))
      if (b instanceof Response) return bail(b)
      const codeRef = b.url ? parseRepoRef(b.url) : null
      if (b.url && !codeRef)
        return bail(
          fail(c, 400, "not a public GitHub or GitLab repository", { code: "not_a_repo" }),
        )
      // A repository may add as much as the paper holds: the gate an import pays for one.
      if (codeRef && (await overStorage(x.org_id, ARXIV_IMPORT_ESTIMATED_BYTES)))
        return bail(fail(c, 413, "this workspace is out of storage", { code: "storage" }))

      await meta.setContextCodeUrl(x.id, codeRef ? repoWebUrl(codeRef) : null)
      // The worker does both jobs: fetching a new repository, and republishing the paper
      // without the previous one. Either way the job runs again, and the paper it already
      // published is resumed from rather than re-fetched.
      const now = new Date().toISOString()
      await meta.updateImportJob(job.id, {
        status: "pending",
        next_attempt_at: now,
        lease_until: null,
        attempts: 0,
        claim_token: null,
        code_status: codeRef ? "pending" : null,
        code_error: null,
        updated_at: now,
      })
      deps.pokeImports?.()
      const updated = await meta.getContext(x.id)
      const manifest = await meta.getArtifactById(x.manifest_artifact_id)
      return c.json(
        contextJson(updated ?? x, manifest?.short_id ?? null, await meta.getImportJob(job.id)),
      )
    },
  )
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/contexts/{id}",
      tags: ["Contexts"],
      summary:
        "One imported paper: its import status, its document, and its BibTeX. An id that was not imported returns 404.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The imported paper.",
          content: {
            "application/json": {
              schema: ContextInfo.extend({
                manifest_md: z
                  .string()
                  .nullable()
                  .optional()
                  .describe(
                    "The manifest's raw source — the runner's system prompt. Agent branch only.",
                  ),
                brandprint: BrandprintConfig.optional(),
                manifest: ManifestInfo.nullable()
                  .optional()
                  .describe(
                    "The manifest, framed for a reader rather than a runner. Human branch only.",
                  ),
                skills: z
                  .array(ManifestSkillInfo)
                  .optional()
                  .describe("Every skill the manifest pins, with pin health. Human branch only."),
                repos: z
                  .array(ManifestRepoInfo)
                  .optional()
                  .describe("Repo pointers from the manifest's frontmatter. Human branch only."),
                max_run_ms: z
                  .number()
                  .nullable()
                  .optional()
                  .describe(
                    "Per-run wall-clock budget; null = the server default. Human branch only.",
                  ),
                max_concurrency: z
                  .number()
                  .optional()
                  .describe("How many sessions the runner may work at once. Human branch only."),
                documents: z
                  .array(ManifestDocumentInfo)
                  .optional()
                  .describe(
                    "Documents the manifest binds (an imported paper's bundle). Human branch only.",
                  ),
                bibtex: z
                  .string()
                  .nullable()
                  .optional()
                  .describe(
                    "An imported paper's own BibTeX entry (its bundle's CITATION.bib). Human branch only.",
                  ),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const x = await meta.getContext(c.req.param("id"))
      // Workspace-scoped: 404 (not 403) to everyone outside it, so its existence never leaks.
      if (!x || !x.import_source || !(await canAskContext(c, x)))
        return bail(fail(c, 404, "not found"))
      const [job, paper] = await Promise.all([
        meta.getImportJobForContext(x.id),
        meta.getArtifactById(x.manifest_artifact_id),
      ])
      if (!paper) return c.json(contextJson(x, null, job))
      const v = await meta.getVersion(paper.id, paper.current_version)
      // The same shape a reader always got for an imported Context: the paper is not a
      // manifest, so it carries no manifest block, pins no skills and points at no repos.
      return c.json({
        ...contextJson(x, paper.short_id, job),
        ...paperSummaryRow(x, v?.author ?? null, paper.current_version),
        manifest: null,
        skills: [],
        repos: [],
        max_run_ms: x.max_run_ms,
        max_concurrency: x.max_concurrency,
        documents: await importedDocuments(x, paper),
        bibtex: await paperBibtex(paper),
      })
    },
  )

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/contexts/{id}/analysis",
      tags: ["Contexts"],
      summary:
        "An imported paper's implementation analysis, and the prompts that start or update it.",
      description:
        "The map an agent published from the paper's contributions to the code that carries them out, with each code reference resolved to the repository's own host at the commit it read. Derive never writes it: `prompts` are what a person pastes into their own agent. Readable by whoever may ask the Context.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Where the analysis stands, and the analysis when there is one.",
          content: { "application/json": { schema: ContextAnalysisInfo } },
        },
      },
    }),
    async (c) => {
      const x = await meta.getContext(c.req.param("id"))
      if (!x || x.import_source !== "arxiv" || !(await canAskContext(c, x)))
        return bail(fail(c, 404, "not found"))
      const [job, paper] = await Promise.all([
        meta.getImportJobForContext(x.id),
        meta.getArtifactById(x.manifest_artifact_id),
      ])
      const state = await paperAnalysisState(meta, ctx.blobs, x, job)
      const root = x.code_url ? parseRepoRef(x.code_url) : null
      const codeReady = !!root && job?.code_status === "ready"
      const commit = codeReady ? (job?.code_commit ?? null) : null
      const readable = state.artifact ? await authorize(c, "read", state.artifact) : true
      // Whether this person's own agents may write it: publish standing on the analysis to
      // update it; on the workspace, and read on the paper, to create it.
      const canPublish = state.artifact
        ? await authorize(c, "publish", state.artifact)
        : !!paper && (await authorize(c, "read", paper)) && (await workspaceCan(c, "publish"))

      let analysis: z.infer<typeof ContextAnalysisInfo>["analysis"] = null
      if (state.analysis && state.artifact && state.version && readable && paper) {
        const a = state.analysis
        const v = await meta.getVersion(paper.id, paper.current_version)
        const manifest = v ? await manifestOf(ctx.blobs, v) : null
        // Linked where the analysis looked: its own repository at its own commit, which is not
        // the Context's any more once the analysis is stale.
        const links = manifest
          ? await analysisLinkerFor(
              { blobs: ctx.blobs, baseUrl: deps.baseUrl },
              paper,
              manifest,
              { ...x, code_url: a.implementation.repository },
              a.implementation.commit,
            )
          : null
        const headings = manifest ? await paperHeadings(manifest, a) : new Map<string, string>()
        const code = (ref: AnalysisCodeRef) => {
          const target = links?.code(ref) ?? null
          return {
            path: ref.path,
            symbol: ref.symbol ?? null,
            lines: ref.lines ?? null,
            href: target?.href ?? null,
            pinned: target?.pinned ?? false,
          }
        }
        const cites = (ref: AnalysisPaperRef) => ({
          section: ref.section,
          label: ref.label ?? null,
          heading: headings.get(ref.section) ?? null,
        })
        analysis = {
          short_id: state.artifact.short_id,
          title: state.artifact.title,
          version: state.artifact.current_version,
          updated_at: state.version.created_at,
          agent: state.version.agent_name ?? null,
          summary: a.summary,
          made_against: {
            arxiv_version: a.paper.arxiv_version,
            repository: a.implementation.repository,
            commit: a.implementation.commit,
          },
          counts: state.counts ?? analysisCounts(a),
          contributions: a.contributions.map((contribution) => ({
            id: contribution.id,
            title: contribution.title,
            claim: contribution.claim,
            paper: contribution.paper.map(cites),
            details: contribution.details.map((d) => ({
              id: d.id,
              title: d.title,
              status: d.status,
              notes: d.notes ?? null,
              paper: d.paper.map(cites),
              code: d.code.map(code),
            })),
          })),
          unmapped: a.unmapped.map((u) => ({ id: u.id, notes: u.notes, ...code(u) })),
          open_questions: a.open_questions,
        }
      }

      const promptInput =
        paper && root && codeReady
          ? {
              baseUrl: deps.baseUrl,
              contextId: x.id,
              contextName: x.name,
              arxivRef: x.import_ref ?? "",
              paperShortId: paper.short_id,
              arxivVersion: job?.resolved_version ?? null,
              repository: root.canonical,
              commit,
            }
          : null
      return c.json({
        state: state.artifact && !readable ? ("restricted" as const) : state.state,
        stale_reasons: readable ? state.staleReasons : [],
        paper_short_id: paper?.short_id ?? null,
        implementation:
          root && x.code_url ? { repository: root.canonical, url: x.code_url, commit } : null,
        analysis,
        prompts: {
          start:
            promptInput && state.state === "none" ? paperAnalysisStartPrompt(promptInput) : null,
          update:
            promptInput && state.artifact && readable
              ? paperAnalysisUpdatePrompt({
                  ...promptInput,
                  analysisShortId: state.artifact.short_id,
                  version: state.artifact.current_version,
                  staleReasons: state.staleReasons,
                })
              : null,
        },
        can_publish: canPublish,
      })
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/contexts/{id}",
      tags: ["Contexts"],
      summary: "Delete an imported paper (its creator or a workspace manager).",
      request: { params: z.object({ id: z.string() }) },
      responses: { 204: { description: "The imported paper was deleted." } },
    }),
    async (c) => {
      // The same guard as the other paper routes: a management principal (never a runner's
      // key), the caller's own workspace, the creator or a manager, and only an imported
      // paper. A Context that was not imported is not this route's to delete.
      const x = await manageableImport(c)
      if (x instanceof Response) return bail(x)
      // An imported Context IS its paper: one artifact, so discarding the Context takes it
      // (the artifact cascade removes the context, its job and its roster with it).
      await deleteArtifactAndUnindex(meta, ctx.search, x.manifest_artifact_id, x.org_id)
      return c.body(null, 204)
    },
  )

  return app
}

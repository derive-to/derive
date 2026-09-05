import {
  artifactRefIn,
  artifactRefOf,
  artifactUrl,
  derivedGen,
  isDerivedFactName,
  LINKED_BUNDLE_CONTENT_TYPE,
  LINKS_FACT,
  SKILL_CONTENT_TYPE,
  templateLibraryUri,
} from "@derive/core"
import { z } from "zod"
import {
  searchArtifactVersion,
  searchMatcher,
  searchReport,
  searchWorkspace,
  searchWorkspaceMany,
  toSearchHits,
} from "../lib/search"
import { listTemplateArtifacts } from "../lib/template-artifacts"
import { visibleArtifactIds } from "../lib/visibility"
import { log } from "../log"
import type { ToolContext } from "../mcp-tool-context"
import {
  err,
  historyNotPublic,
  json,
  runnerOnline,
  safeJson,
  summarizeArtifact,
  text,
  versionOpenToWorld,
} from "../mcp-util"

// FIND — one tool over BROWSE (list_artifacts) + GREP/SEARCH (search) + the askable
// CONTEXTS (list_contexts), discriminated by argument. The mode is decided by what's
// passed: `short_id` ⇒ grep within it; `query` alone ⇒ search the workspace; neither ⇒
// browse. Result rows are typed (artifact | match | context) so a mixed listing is
// unambiguous. -----------------------------------------------------------------------
const CONTEXTS_NEED_HUMAN =
  "Contexts are hidden here because this connection has no signed-in user. Reconnect with an OAuth login to see and use them."

/** Rows returned by a cross-artifact fact read. The store is asked for twice this many so
 *  the visibility gate has slack to drop invisible ones without shortening the answer. */
const FACT_RESULT_CAP = 200

/** Backlink rows returned. Higher than FACT_RESULT_CAP deliberately: a fact row carries a
 *  whole JSON payload (up to MAX_FACT_BYTES, 32KiB), a backlink row carries a short id, a
 *  title and a date — about 80 bytes. 500 of them is comparable to a SINGLE page of
 *  find(data:). An index capped by a payload-shaped constant is capped for the wrong
 *  reason, and this one is capping the thing it exists to be exhaustive about. */
const BACKLINK_RESULT_CAP = 500
const CODE_COMPACT_RESULT_CAP = 8
const CODE_COMPACT_SEARCH_LIMIT = 16
const CODE_COMPACT_CANDIDATE_CAP = 64

/** Host-only execution data for code-mode bulk find. Symbols cannot cross the sandbox bridge, so
 *  model-written code cannot choose internal search limits or forge a prepared response. */
export const CODE_FIND_ENVELOPE = Symbol("derive-code-find-envelope")
export interface CodeFindEnvelope {
  compact: true
  prepared?: Record<string, unknown>
}

/** The refs a stored $links payload actually asserts. The CONFIRM half of the store's
 *  narrow-then-confirm: its LIKE is a substring match over raw JSON, and a substring match
 *  is not proof (see MetaStore.listArtifactsLinkingTo). Malformed JSON is a corrupt cache
 *  entry — it costs that candidate, never the query. */
const refsOf = (jsonText: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(jsonText)
    const refs = (parsed as { refs?: unknown } | null)?.refs
    return Array.isArray(refs) ? refs.filter((r): r is string => typeof r === "string") : []
  } catch {
    return []
  }
}

/** The notes on a backlink answer. Pure and separate so the truncation and staleness copy
 *  can be tested without publishing five hundred linkers.
 *
 *  THE EMPTY NOTE COVERS THREE STATES ON PURPOSE. "Nothing links here", "the linkers were
 *  never derived", and "no such artifact / it lives in another workspace" must read
 *  identically, or find(links_to:) becomes an oracle for whether a short id exists. So it
 *  neither confirms nor denies the target, names both coverage gaps, and points at a count
 *  that is ALREADY visibility-gated rather than inventing a new one. */
export const backlinkNotes = (o: {
  ref: string
  count: number
  truncated: boolean
  stale: number
  tag?: string
}): { note?: string; next?: string } => {
  const notes: string[] = []
  if (!o.count)
    notes.push(
      `Nothing you can see links to "${o.ref}"${o.tag ? ` under tag "${o.tag}"` : ""} on its current version. This index reads the host-derived $links fact: a version published before derivation shipped carries no row until it is republished or read once, and archive bundles and skills carry no facts, so references inside their pages are never indexed. find(data:"$*") shows how many artifacts currently carry $links.`,
    )
  if (o.truncated)
    notes.push(
      `Capped at ${BACKLINK_RESULT_CAP} linking artifacts; more exist. Narrow with tag:"…".`,
    )
  if (o.stale)
    notes.push(
      `${o.stale} of these were indexed by an earlier version of the link deriver. Refresh one with read(short_id, data:"$links").`,
    )
  return {
    ...(notes.length ? { note: notes.join(" ") } : {}),
    ...(o.count
      ? {
          next: `$links records THAT a reference exists, never why. find(short_id:"<one of these>", query:"${o.ref}") shows the line each one sits on.`,
        }
      : {}),
  }
}

const contextFindRowsFor = async (
  tc: ToolContext,
  org: string,
  matches?: (name: string) => boolean,
) => {
  const { actingFor, askableContexts, ctx } = tc
  if (!actingFor) return []
  const rows = await askableContexts(org, actingFor.id)
  const picked = matches ? rows.filter(({ x }) => matches(x.name)) : rows
  return Promise.all(
    picked.map(async ({ x, manifest }) => {
      const open = (await ctx.meta.listSessions(x.id, { askerId: actingFor.id, limit: 10 }))
        .filter((session) => session.state !== "closed")
        .map((session) => ({
          id: session.id,
          state: session.state,
          updated_at: session.updated_at ?? session.created_at,
        }))
      return {
        type: "context" as const,
        id: x.id,
        name: x.name,
        online: runnerOnline(x),
        manifest: manifest ? { short_id: manifest.short_id, title: manifest.title } : null,
        your_open_sessions: open,
        note: "read({short_id: id}) loads its package (manifest + skill pointers); use({context, instruction}) starts a run with it.",
      }
    }),
  )
}

const codeFindEligible = (
  args: Record<string, unknown>,
): args is Record<string, unknown> & {
  query: string
} => {
  if (typeof args.query !== "string" || !args.query) return false
  const allowed = new Set(["query", "case_sensitive", "in", "context", "max_matches", "workspace"])
  return Object.keys(args).every((key) => allowed.has(key))
}

/** Prepare compact workspace searches as workspace batches. The returned map is keyed by the
 *  original argument objects, so only the host can attach a prepared result to a handler call. */
export const prepareCodeFindMany = async (
  tc: ToolContext,
  requests: Record<string, unknown>[],
): Promise<Map<Record<string, unknown>, Record<string, unknown>>> => {
  const eligible = requests.filter(codeFindEligible)
  const prepared = new Map<Record<string, unknown>, Record<string, unknown>>()
  const byWorkspace = new Map<string, typeof eligible>()
  for (const request of eligible) {
    const key = typeof request.workspace === "string" ? request.workspace : ""
    const rows = byWorkspace.get(key) ?? []
    rows.push(request)
    byWorkspace.set(key, rows)
  }
  for (const rows of byWorkspace.values()) {
    const workspace = typeof rows[0]?.workspace === "string" ? rows[0].workspace : undefined
    const target = await tc.resolveWs(workspace)
    if ("error" in target) continue
    const queries = rows.map((request) => {
      const context = Number(request.context)
      const maxMatches = Number(request.max_matches)
      const query = request.query
      return {
        query,
        re: searchMatcher(query, request.case_sensitive === true),
        where: request.in === "text" ? ("text" as const) : ("source" as const),
        ctxLines: Number.isFinite(context) ? Math.min(Math.max(context, 0), 5) : 0,
        cap: Number.isFinite(maxMatches) ? Math.min(Math.max(maxMatches, 1), 200) : 40,
        limit: CODE_COMPACT_SEARCH_LIMIT,
        candidateCap: CODE_COMPACT_CANDIDATE_CAP,
      }
    })
    const searched = await searchWorkspaceMany(
      tc.ctx,
      {
        orgId: target.org,
        viewerId: tc.actingFor?.id ?? tc.agent.id,
      },
      queries,
    )
    const needles = rows.map(({ query }) => query.toLowerCase())
    const contextRows = await contextFindRowsFor(tc, target.org, (name) => {
      const lower = name.toLowerCase()
      return needles.some((needle) => lower.includes(needle))
    })
    for (const [index, request] of rows.entries()) {
      const query = request.query
      const search = searched[index]
      if (!search) continue
      const matches = toSearchHits(search.results, query).map((hit) => ({
        type: "match" as const,
        ...hit,
      }))
      const contexts = contextRows.filter((row) =>
        row.name.toLowerCase().includes(query.toLowerCase()),
      )
      prepared.set(request, {
        workspace: target.org,
        query,
        where: queries[index]?.where ?? "source",
        count: matches.length + contexts.length,
        results: [...matches, ...contexts],
        ...(search.note ? { note: search.note } : {}),
        ...(tc.actingFor ? {} : { contexts_note: CONTEXTS_NEED_HUMAN }),
      })
    }
  }
  return prepared
}

export function registerFindTool(tc: ToolContext): void {
  const { server, ctx, agent, actingFor, ownerId, reach, notFound, resolveWs, wsArg } = tc

  // Askable contexts as typed `find` rows — INVARIANT (A): sourced ONLY from
  // askableContexts (the per-human canUserAskContext gate), so a roster-gated context this
  // user may not ask never appears; (B): with no acting human this returns [] and the
  // caller adds an explicit note rather than erroring. Each row carries its own open
  // sessions and the steer to reach it with `use`. (askableContexts/runnerOnline are
  // defined further down; referenced here from a handler that runs at call-time.)
  const contextFindRows = (org: string, matches?: (name: string) => boolean) =>
    contextFindRowsFor(tc, org, matches)
  server.registerTool(
    "find",
    {
      description:
        "Find things; what you pass picks the MODE. `templates:true` finds reusable starts, `short_id`+`query` GREPs one artifact, `query` alone SEARCHES the workspace, `links_to` gives BACKLINKS, neither browses the library. Search is LITERAL: ONE keyword, never a phrase or question. Chains: `derive_code`. See derive://skills/finding.",
      annotations: {
        title: "Find artifacts",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "With `short_id`: the literal text to grep within it (metacharacters are not special). Alone (no short_id): the workspace content search. Omit both to browse.",
          )
          // The literal-search rule is stated in the tool description and still gets read as
          // advice. Showing the shape is what lands it: agents send whole questions to a
          // character-matching search, get nothing back, and report an empty workspace.
          .meta({ examples: ["pricing", "backfill", "atlas"] }),
        short_id: z
          .string()
          .optional()
          .describe("Grep WITHIN this one artifact (needs `query`). Omit to browse or search."),
        tag: z
          .string()
          .optional()
          .describe(
            "Browse only: artifacts carrying this browse tag (case-insensitive). Also narrows `data` to that tagged set.",
          ),
        data: z
          .string()
          .optional()
          .describe(
            'Read one FACT across every artifact carrying it, at each one\'s current version. Scope with `tag`. "*" lists authored facts, "$*" the host-derived ones. Reaches what a search would, never a teammate\'s invite-only doc.',
          ),
        skills: z
          .boolean()
          .optional()
          .describe(
            "Browse only: list only skills (bundles with a SKILL.md — reusable agent procedure).",
          ),
        archived: z
          .boolean()
          .optional()
          .describe("Browse only: true lists the archive shelf instead of the live library."),
        templates: z
          .boolean()
          .optional()
          .describe(
            "Find reusable starts: artifacts tagged `template` (this workspace's own, then public ones) and accessible authored library entries. Combine with `query` to filter by title or tag; omit it to browse the shelf.",
          ),
        case_sensitive: z.boolean().optional(),
        in: z
          .enum(["source", "text"])
          .optional()
          .describe(
            "Grep/search: source (default) the exact stored bytes (the positions you'd edit); text the visible text a reader sees (HTML tags stripped).",
          ),
        context: z.coerce
          .number()
          .optional()
          .describe(
            "Grep/search: lines of surrounding context around each match (default 0, max 5).",
          ),
        max_matches: z.coerce
          .number()
          .optional()
          .describe(
            "Grep/search: cap on matches per artifact (default 40). Templates: cap total results (default 100). Maximum 200.",
          ),
        links_to: z
          .string()
          .optional()
          .describe(
            "BACKLINKS: which artifacts link TO this one, by short id or URL. Exhaustive, unlike `query`. Bundles and skills carry no facts, so links inside them are never counted.",
          ),
        version: z.coerce.number().optional(),
        workspace: wsArg,
      },
    },
    async (input) => {
      const codeEnvelope = (input as typeof input & { [CODE_FIND_ENVELOPE]?: CodeFindEnvelope })[
        CODE_FIND_ENVELOPE
      ]
      const {
        query,
        short_id,
        tag,
        data,
        links_to,
        skills,
        archived,
        templates,
        case_sensitive,
        in: scope,
        context,
        max_matches,
        version,
        workspace,
      } = input
      if (
        archived &&
        (query || short_id || data !== undefined || links_to !== undefined || templates)
      )
        return err(
          "`archived:true` applies only to browse mode (omit query/short_id/data/links_to/templates).",
        )
      if (templates && (short_id || data !== undefined || links_to || skills || archived))
        return err(
          "`templates:true` finds reusable starts. Combine it only with `query` and `workspace`.",
        )
      if (templates) {
        const t = await resolveWs(workspace)
        if ("error" in t) return err(t.error)
        const cap = Math.min(Math.max(max_matches ?? 100, 1), 200)
        const needle = query?.trim().toLowerCase() ?? ""
        // The same shelf GET /v1/templates serves, at the agent's reach.
        const { rows: shelf, truncated: shelfTruncated } = await listTemplateArtifacts(ctx.meta, {
          workspace: { orgId: t.org, viewerId: actingFor?.id ?? agent.id },
          query: needle,
        })
        const shelfTags = await ctx.meta.tagsForArtifacts(shelf.map((row) => row.artifact.id))
        const templateRows = shelf.map(({ artifact, shelf: source }) => ({
          type: "template" as const,
          source,
          ...summarizeArtifact(artifact),
          tags: shelfTags[artifact.id] ?? [],
          uri: artifact.short_id,
          // Readable by anyone even where this grant can't reach the row by id.
          url: artifactUrl(ctx.deps.baseUrl, artifact),
        }))
        const authoredCapacity = Math.max(cap - templateRows.length, 0)
        // One past capacity even at zero, so a full shelf still reports entries beyond it.
        const authoredAll = await ctx.meta.searchTemplateLibraryEntries({
          orgId: t.org,
          ownerId,
          ...(needle ? { query: needle } : {}),
          limit: authoredCapacity + 1,
        })
        const authoredRows = authoredAll.slice(0, authoredCapacity).map(({ library, entry }) => ({
          type: "template" as const,
          source: "library" as const,
          id: entry.id,
          title: entry.title,
          description: entry.description,
          kind: entry.kind,
          category: entry.category,
          format: entry.format,
          library: { id: library.id, title: library.title, scope: library.scope },
          uri: templateLibraryUri(library.id, entry.id),
        }))
        const allResults = [...templateRows, ...authoredRows]
        const results = allResults.slice(0, cap)
        const truncated =
          shelfTruncated || templateRows.length > cap || authoredAll.length > authoredCapacity
        return json({
          workspace: t.org,
          ...(query ? { query } : {}),
          count: results.length,
          results,
          truncated,
          next:
            (truncated ? "Refine query to narrow the shelf. " : "") +
            "Read a result's uri (its short_id), publish a new artifact with derived_from set to it, and inspect the render. A public row from another workspace reads at its current version.",
        })
      }
      // Claimed BEFORE mode 1, which owns `short_id` and would answer a `links_to` call with
      // "`query` is required to grep" — the wrong error for a caller who asked a different
      // question. Backlinks reach artifacts by content across the workspace; the other three
      // modes reach one artifact by id, or rank text. They do not compose.
      if (links_to !== undefined && (query || short_id || data !== undefined))
        return err(
          "`links_to` asks which artifacts link to one target — pass it with `tag` (to scope the set), but not with `query`/`short_id` (which grep or rank one artifact's text) or `data` (which reads a fact by name).",
        )
      if (links_to !== undefined && version !== undefined)
        return err(
          "`links_to` has no version dimension: the inversion joins each artifact's CURRENT version, and a reference to @v4 and one to current are the same edge.",
        )
      // MODE 1 — GREP WITHIN ONE ARTIFACT. Byte-for-byte the former search(short_id):
      // matching lines, line numbers, in:'source'|'text', context lines, a chosen version.
      if (short_id) {
        if (!query) return err("`query` is required to grep within an artifact (short_id).")
        const re = searchMatcher(query, case_sensitive ?? false)
        const ctxLines = Math.min(Math.max(context ?? 0, 0), 5)
        const cap = Math.min(Math.max(max_matches ?? 40, 1), 200)
        const where = scope ?? "source"
        const r = await reach(short_id, workspace, { public: true })
        if (r && "error" in r) return err(r.error)
        if (!r) return notFound(short_id)
        const a = r.a
        const n = version ?? a.current_version
        if (n < 1 || n > a.current_version)
          return err(`No version ${n} for "${short_id}" — it has versions 1..${a.current_version}.`)
        if (r.public && !versionOpenToWorld(a, n)) return historyNotPublic(short_id, a)
        const v = await ctx.meta.getVersion(a.id, n)
        if (!v) return err(`Version ${n} of "${short_id}" is unavailable.`)
        const { groups, total, note } = await searchArtifactVersion(
          ctx,
          v,
          re,
          where,
          ctxLines,
          cap,
        )
        return text(searchReport(short_id, query, where, total, cap, groups, note))
      }

      // MODE 2 — SEARCH THE WORKSPACE (ranked artifacts + a snippet each), plus any askable
      // context whose NAME matches the query. Typed rows: {type:"match"} + {type:"context"}.
      if (query) {
        if (codeEnvelope?.prepared) return json(codeEnvelope.prepared)
        const t = await resolveWs(workspace)
        if ("error" in t) return err(t.error)
        const re = searchMatcher(query, case_sensitive ?? false)
        const ctxLines = Math.min(Math.max(context ?? 0, 0), 5)
        const cap = Math.min(Math.max(max_matches ?? 40, 1), 200)
        const where = scope ?? "source"
        const { results, note } = await searchWorkspace(ctx, {
          orgId: t.org,
          viewerId: actingFor?.id ?? agent.id,
          query,
          re,
          where,
          ctxLines,
          cap,
          ...(codeEnvelope?.compact
            ? {
                limit: CODE_COMPACT_SEARCH_LIMIT,
                candidateCap: CODE_COMPACT_CANDIDATE_CAP,
              }
            : {}),
        })
        const matchRows = toSearchHits(results, query).map((h) => ({
          type: "match" as const,
          ...h,
        }))
        const q = query.toLowerCase()
        const contextRows = await contextFindRows(t.org, (name) => name.toLowerCase().includes(q))
        return json({
          workspace: t.org,
          query,
          where,
          count: matchRows.length + contextRows.length,
          results: [...matchRows, ...contextRows],
          ...(note ? { note } : {}),
          ...(actingFor ? {} : { contexts_note: CONTEXTS_NEED_HUMAN }),
        })
      }

      const t = await resolveWs(workspace)
      if ("error" in t) return err(t.error)

      // MODE 3 — CROSS-ARTIFACT DATA. read(data, versions) answers "how did this ONE page
      // change over time"; this answers "where does this metric stand everywhere", which
      // is the question a workspace of nightly reports actually gets asked. Every row is
      // an artifact's CURRENT version, joined at the store so a superseded row can never
      // be reported as the present state.
      if (data !== undefined) {
        if (query || short_id)
          return err(
            "`data` reads facts across the workspace — pass it with `tag` (to scope the set) but not with `query`/`short_id`, which grep one artifact or search text.",
          )
        // Both reads below reach artifacts by a METRIC NAME rather than by id, so the
        // store scopes them to the org and stops there. An org is not a read permission:
        // an artifact can be invite-only within its own workspace. Everything the store
        // hands back therefore passes the same visibility gate workspace search uses
        // before it is counted or returned.
        const viewer = { orgId: t.org, viewerId: actingFor?.id ?? agent.id }
        if (data === "*" || data === "$*") {
          // TWO catalogs, deliberately never one. "*" is the ASSERTED catalog — the
          // adoption substrate, what authors chose to emit — and derived names are
          // excluded from it structurally, so the host's own output can never read as
          // adoption. "$*" is the DERIVED catalog, explicit and separate: the index the
          // host builds over everything, useful precisely because it is everywhere.
          const wantDerived = data === "$*"
          const rows = (await ctx.meta.listWorkspaceFacts(t.org)).filter(
            (r) => isDerivedFactName(r.slot) === wantDerived,
          )
          const allowed = await visibleArtifactIds(
            ctx.meta,
            [...new Set(rows.map((r) => r.artifact_id))],
            viewer,
          )
          // Count over what this caller can actually see, not over the workspace.
          const byName = new Map<string, { artifacts: Set<string>; latest_at: string }>()
          for (const r of rows) {
            if (!allowed.has(r.artifact_id)) continue
            const e = byName.get(r.slot) ?? { artifacts: new Set<string>(), latest_at: r.at }
            e.artifacts.add(r.artifact_id)
            if (r.at > e.latest_at) e.latest_at = r.at
            byName.set(r.slot, e)
          }
          const catalog = [...byName.entries()]
            .map(([fact, e]) => ({ fact, artifacts: e.artifacts.size, latest_at: e.latest_at }))
            .sort((a, b) => b.artifacts - a.artifacts || a.fact.localeCompare(b.fact))
          return json({
            workspace: t.org,
            count: catalog.length,
            facts: catalog,
            ...(wantDerived ? { derived: true } : {}),
            ...(catalog.length
              ? {
                  next: `Read one across the workspace with find(data:"${catalog[0]?.fact}"), or one artifact's history with read(short_id, data:"${catalog[0]?.fact}", versions:"all").`,
                }
              : {
                  note: wantDerived
                    ? "No derived facts yet — they appear as versions publish (or on first read of an older version)."
                    : "No facts in this workspace yet. A page carries one as a `derive-data` block (see derive://skills/publishing); it becomes queryable the moment it publishes.",
                }),
          })
        }
        // Over-fetch, THEN gate, then cut to the display cap. Gating a hard 200 would let a
        // run of artifacts the caller cannot see eat the whole page and answer "no artifact
        // carries this slot" — a wrong answer dressed as an empty one. Nothing about what
        // was dropped is reported: a "some results were filtered" note would disclose the
        // existence of the very documents the gate is hiding.
        const found = await ctx.meta.listFactAcrossArtifacts(t.org, data, {
          tag: tag?.trim().toLowerCase(),
          limit: FACT_RESULT_CAP * 2,
        })
        const allowed = await visibleArtifactIds(
          ctx.meta,
          found.map((r) => r.id),
          viewer,
        )
        const rows = found.filter((r) => allowed.has(r.id)).slice(0, FACT_RESULT_CAP)
        log.info("fact_read", { name: data, derived: isDerivedFactName(data), surface: "find" })
        return json({
          workspace: t.org,
          fact: data,
          ...(tag ? { tag } : {}),
          count: rows.length,
          results: rows.map((r) => ({
            short_id: r.short_id,
            title: r.title,
            version: r.n,
            at: r.at,
            data: safeJson(r.json),
          })),
          ...(rows.length
            ? {}
            : {
                note: `No artifact${tag ? ` tagged "${tag}"` : ""} carries a "${data}" slot on its current version. Pass data:"*" to see which facts exist.`,
              }),
        })
      }

      // MODE 3b — BACKLINKS, the corpus INVERSION. Every derived fact is per artifact, per
      // version; the question a corpus actually gets asked is the other shape. Inverting
      // $links client-side means pulling every artifact's payload and folding it here —
      // one call at 193 artifacts, a scan at 10k, and capped at FACT_RESULT_CAP either way,
      // so the client-side answer is not merely slow but inexhaustive. The answer to ONE
      // target is small even though the scan is corpus-sized, which is why this is a query
      // and not a table: never store what you can recompute, until reads exceed rebuilds.
      if (links_to !== undefined) {
        const ref = artifactRefIn(links_to) ?? artifactRefOf(links_to.trim())
        if (!ref)
          return err(
            `"${links_to}" is not an artifact reference. Pass a short id (abc12345), a titled ref (my-doc-abc12345) or an artifact URL.`,
          )
        const t = await resolveWs(workspace)
        if ("error" in t) return err(t.error)
        const viewer = { orgId: t.org, viewerId: actingFor?.id ?? agent.id }
        const started = Date.now()
        // Over-fetch, CONFIRM, then gate, then cut — same order as the named read above and
        // for the same reason. The confirm goes BEFORE the gate so a row the LIKE matched
        // but the payload does not actually reference never costs a visibility lookup.
        const candidates = await ctx.meta.listArtifactsLinkingTo(t.org, ref, {
          tag: tag?.trim().toLowerCase(),
          limit: BACKLINK_RESULT_CAP * 2,
        })
        const confirmed = candidates.filter((r) => refsOf(r.json).includes(ref))
        const allowed = await visibleArtifactIds(
          ctx.meta,
          confirmed.map((r) => r.id),
          viewer,
        )
        const visible = confirmed.filter((r) => allowed.has(r.id))
        const rows = visible.slice(0, BACKLINK_RESULT_CAP)
        // TRUNCATION is reported; visibility filtering is NOT, and the difference is not a
        // nicety. A scan bound is caller-independent — an omniscient caller hits the same
        // cap, so saying so discloses nothing. A visibility filter is caller-dependent, so
        // "some results were hidden" would disclose the existence of the very documents the
        // gate exists to hide. An index that silently truncates is the failure this whole
        // surface is a reaction to, so the first half MUST be said.
        const truncated =
          candidates.length >= BACKLINK_RESULT_CAP * 2 || visible.length > rows.length
        const staleRows = rows.filter((r) => r.gen !== derivedGen(LINKS_FACT)).length
        log.info("fact_read", { name: LINKS_FACT, derived: true, surface: "backlinks" })
        // The pre-gate numbers, in the log where they belong: `candidates` is what decides
        // whether this ever needs materializing. Do that when p95 ms crosses 500, or when
        // calls/day x candidates exceeds the publish rate (reads exceeding rebuilds).
        // Today: 193 artifacts, ~18 candidates for a real target, one 641ms call for the
        // whole $links corpus.
        log.info("backlinks_query", {
          org: t.org,
          candidates: candidates.length,
          confirmed: confirmed.length,
          returned: rows.length,
          truncated,
          ms: Date.now() - started,
        })
        return json({
          workspace: t.org,
          links_to: ref,
          ...(tag ? { tag } : {}),
          count: rows.length,
          results: rows.map((r) => ({
            type: "backlink" as const,
            short_id: r.short_id,
            title: r.title,
            version: r.n,
            at: r.at,
            is_linked_bundle: r.current_content_type === LINKED_BUNDLE_CONTENT_TYPE,
            ...(r.short_id === ref ? { self: true } : {}),
          })),
          ...backlinkNotes({ ref, count: rows.length, truncated, stale: staleRows, tag }),
        })
      }

      // MODE 4 — BROWSE the library: list_artifacts rows (skills:/tag facets), plus every
      // askable context. A tag filter resolves to an id set first (mirrors the HTTP ?tag=
      // path); viewerId keeps private rows scoped to the agent's human (mirrors `reach`).
      const ids = tag ? await ctx.meta.artifactIdsByTag(tag.trim().toLowerCase()) : undefined
      const rows =
        ids && ids.length === 0
          ? []
          : await ctx.meta.listArtifacts({
              orgId: t.org,
              ids,
              viewerId: actingFor?.id ?? agent.id,
              archived: archived ? "only" : "exclude",
              // Skill-ness is the denormalized content type; the store filters it.
              ...(skills ? { contentType: SKILL_CONTENT_TYPE } : {}),
              ...(codeEnvelope?.compact ? { limit: CODE_COMPACT_RESULT_CAP + 1 } : {}),
            })
      const browseTruncated = codeEnvelope?.compact && rows.length > CODE_COMPACT_RESULT_CAP
      const boundedRows = codeEnvelope?.compact ? rows.slice(0, CODE_COMPACT_RESULT_CAP) : rows
      const tagMap = await ctx.meta.tagsForArtifacts(boundedRows.map((a) => a.id))
      const artifactRows = boundedRows.map((a) => ({
        type: "artifact" as const,
        ...summarizeArtifact(a),
        tags: tagMap[a.id] ?? [],
      }))
      const contextRows = archived ? [] : await contextFindRows(t.org)
      return json({
        workspace: t.org,
        count: artifactRows.length + contextRows.length,
        results: [...artifactRows, ...contextRows],
        ...(browseTruncated ? { truncated: true } : {}),
        ...(actingFor ? {} : { contexts_note: CONTEXTS_NEED_HUMAN }),
      })
    },
  )
}

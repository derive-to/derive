import {
  artifactRefIn,
  artifactRefOf,
  derivedGen,
  isDerivedFactName,
  LINKS_FACT,
  SKILL_CONTENT_TYPE,
} from "@derive/core"
import { z } from "zod"
import {
  searchArtifactVersion,
  searchMatcher,
  searchReport,
  searchWorkspace,
  toSearchHits,
} from "../lib/search"
import { visibleArtifactIds } from "../lib/visibility"
import { log } from "../log"
import type { ToolContext } from "../mcp-tool-context"
import { err, json, runnerOnline, safeJson, summarizeArtifact, text } from "../mcp-util"

// FIND — one tool over BROWSE (list_artifacts) + GREP/SEARCH (search) + the askable
// CONTEXTS (list_contexts), discriminated by argument. The mode is decided by what's
// passed: `short_id` ⇒ grep within it; `query` alone ⇒ search the workspace; neither ⇒
// browse. Result rows are typed (artifact | match | context) so a mixed listing is
// unambiguous. -----------------------------------------------------------------------
const CONTEXTS_NEED_HUMAN =
  "Contexts (askable live data agents) are hidden here: this connection has no signed-in user. Reconnect with an OAuth login to see and use them."

/** Rows returned by a cross-artifact fact read. The store is asked for twice this many so
 *  the visibility gate has slack to drop invisible ones without shortening the answer. */
const FACT_RESULT_CAP = 200

/** Backlink rows returned. Higher than FACT_RESULT_CAP deliberately: a fact row carries a
 *  whole JSON payload (up to MAX_FACT_BYTES, 32KiB), a backlink row carries a short id, a
 *  title and a date — about 80 bytes. 500 of them is comparable to a SINGLE page of
 *  find(data:). An index capped by a payload-shaped constant is capped for the wrong
 *  reason, and this one is capping the thing it exists to be exhaustive about. */
const BACKLINK_RESULT_CAP = 500

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
      `Nothing you can see links to "${o.ref}"${o.tag ? ` under tag "${o.tag}"` : ""} on its current version. This index reads the host-derived $links fact: a version published before derivation shipped carries no row until it is republished or read once, and bundles and skills carry no facts at all, so references inside their pages are never indexed. find(data:"$*") shows how many artifacts currently carry $links.`,
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

export function registerFindTool(tc: ToolContext): void {
  const { server, ctx, agent, actingFor, reach, notFound, resolveWs, wsArg, askableContexts } = tc

  // Askable contexts as typed `find` rows — INVARIANT (A): sourced ONLY from
  // askableContexts (the per-human canUserAskContext gate), so a roster-gated context this
  // user may not ask never appears; (B): with no acting human this returns [] and the
  // caller adds an explicit note rather than erroring. Each row carries its own open
  // sessions and the steer to reach it with `use`. (askableContexts/runnerOnline are
  // defined further down; referenced here from a handler that runs at call-time.)
  const contextFindRows = async (org: string, matches?: (name: string) => boolean) => {
    if (!actingFor) return []
    const human = actingFor
    const rows = await askableContexts(org, human.id)
    const picked = matches ? rows.filter(({ x }) => matches(x.name)) : rows
    return Promise.all(
      picked.map(async ({ x, manifest }) => {
        const open = (await ctx.meta.listSessions(x.id, { askerId: human.id, limit: 10 }))
          .filter((s) => s.state !== "closed")
          .map((s) => ({ id: s.id, state: s.state, updated_at: s.updated_at ?? s.created_at }))
        return {
          type: "context" as const,
          id: x.id,
          name: x.name,
          online: runnerOnline(x),
          manifest: manifest ? { short_id: manifest.short_id, title: manifest.title } : null,
          your_open_sessions: open,
          note: "read({short_id: id}) loads its package (manifest + skill pointers); use({context, instruction}) gives it work.",
        }
      }),
    )
  }
  server.registerTool(
    "find",
    {
      description:
        "Find things; what you pass picks the MODE. `short_id`+`query` GREPs one artifact (in:'source' by default, the exact bytes; in:'text' the visible words), `query` alone SEARCHES the workspace, `links_to` gives BACKLINKS, neither browses the library. Search is LITERAL: ONE keyword, never a phrase or question; empty means try another word, never that nothing exists. See derive://skills/finding.",
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
          ),
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
          .describe("Grep/search: cap on matches per artifact (default 40, max 200)."),
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
    async ({
      query,
      short_id,
      tag,
      data,
      links_to,
      skills,
      archived,
      case_sensitive,
      in: scope,
      context,
      max_matches,
      version,
      workspace,
    }) => {
      if (archived && (query || short_id || data !== undefined || links_to !== undefined))
        return err(
          "`archived:true` applies only to browse mode (omit query/short_id/data/links_to).",
        )
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
        const r = await reach(short_id, workspace)
        if (r && "error" in r) return err(r.error)
        if (!r) return notFound(short_id)
        const a = r.a
        const n = version ?? a.current_version
        if (n < 1 || n > a.current_version)
          return err(`No version ${n} for "${short_id}" — it has versions 1..${a.current_version}.`)
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
            ...(r.short_id === ref ? { self: true } : {}),
          })),
          ...backlinkNotes({ ref, count: rows.length, truncated, stale: staleRows, tag }),
        })
      }

      // MODE 4 — BROWSE the library: list_artifacts rows (skills:/tag facets), plus every
      // askable context. A tag filter resolves to an id set first (mirrors the HTTP ?tag=
      // path); viewerId keeps private rows scoped to the agent's human (mirrors `reach`).
      const ids = tag ? await ctx.meta.artifactIdsByTag(tag.trim().toLowerCase()) : undefined
      const arts =
        ids && ids.length === 0
          ? []
          : await ctx.meta.listArtifacts({
              orgId: t.org,
              ids,
              viewerId: actingFor?.id ?? agent.id,
              archived: archived ? "only" : "exclude",
            })
      // Skill-ness isn't a store-level filter (it's the denormalized content type).
      const rows = skills ? arts.filter((a) => a.current_content_type === SKILL_CONTENT_TYPE) : arts
      const tagMap = await ctx.meta.tagsForArtifacts(rows.map((a) => a.id))
      const artifactRows = rows.map((a) => ({
        type: "artifact" as const,
        ...summarizeArtifact(a),
        tags: tagMap[a.id] ?? [],
      }))
      const contextRows = archived ? [] : await contextFindRows(t.org)
      return json({
        workspace: t.org,
        count: artifactRows.length + contextRows.length,
        results: [...artifactRows, ...contextRows],
        ...(actingFor ? {} : { contexts_note: CONTEXTS_NEED_HUMAN }),
      })
    },
  )
}

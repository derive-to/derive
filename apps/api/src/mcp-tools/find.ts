import { isDerivedFactName, SKILL_CONTENT_TYPE } from "@derive/core"
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
        "Find things in Derive — the MODE is decided by what you pass. Pass `short_id` + `query` to GREP within one artifact: matching lines with line numbers (in:'source'|'text', context lines, a past `version`), so you can then read a `lines` range or edit that spot. Pass `query` ALONE to SEARCH the whole workspace — artifacts ranked by relevance with a snippet each, so you find WHICH doc has something before opening it; this ALSO surfaces any askable context whose name matches. Pass NEITHER to BROWSE the library: every artifact (short id, title, kind, is_skill, version, access, tags — skills:true or a `tag` narrows it) PLUS the askable contexts. Rows are typed (artifact | match | context); `read` a context row for its package, `use` it to give it work. Includes your own unlisted work. For the browse→work rhythm, read derive://skills/loop.",
      annotations: { readOnlyHint: true },
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
            'Read one FACT across every artifact in the workspace that carries it — "where does this metric stand everywhere", the cross-artifact companion to read(data, versions) which answers "how did this ONE page change over time". Each row is that artifact\'s CURRENT version. Combine with `tag` to scope it to a set (e.g. data:"checks", tag:"nightly"). Pass "*" to list which AUTHORED facts exist and how many artifacts carry each; "$*" lists the host-DERIVED ones ($outline/$links/$stats — computed, never authored, never counted as adoption). Reaches exactly what a search would: your own artifacts plus the workspace-listed ones, never a teammate\'s invite-only doc — so a count here is what YOU can see, not what the workspace holds.',
          ),
        skills: z
          .boolean()
          .optional()
          .describe(
            "Browse only: list only skills (bundles with a SKILL.md — reusable agent procedure).",
          ),
        case_sensitive: z.boolean().optional().describe("Grep/search: default false."),
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
        version: z.coerce
          .number()
          .optional()
          .describe("Grep within a past version (short_id mode). Defaults to the current one."),
        workspace: wsArg,
      },
    },
    async ({
      query,
      short_id,
      tag,
      data,
      skills,
      case_sensitive,
      in: scope,
      context,
      max_matches,
      version,
      workspace,
    }) => {
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

      // MODE 4 — BROWSE the library: list_artifacts rows (skills:/tag facets), plus every
      // askable context. A tag filter resolves to an id set first (mirrors the HTTP ?tag=
      // path); viewerId keeps private rows scoped to the agent's human (mirrors `reach`).
      const ids = tag ? await ctx.meta.artifactIdsByTag(tag.trim().toLowerCase()) : undefined
      const arts =
        ids && ids.length === 0
          ? []
          : await ctx.meta.listArtifacts({ orgId: t.org, ids, viewerId: actingFor?.id ?? agent.id })
      // Skill-ness isn't a store-level filter (it's the denormalized content type).
      const rows = skills ? arts.filter((a) => a.current_content_type === SKILL_CONTENT_TYPE) : arts
      const tagMap = await ctx.meta.tagsForArtifacts(rows.map((a) => a.id))
      const artifactRows = rows.map((a) => ({
        type: "artifact" as const,
        ...summarizeArtifact(a),
        tags: tagMap[a.id] ?? [],
      }))
      const contextRows = await contextFindRows(t.org)
      return json({
        workspace: t.org,
        count: artifactRows.length + contextRows.length,
        results: [...artifactRows, ...contextRows],
        ...(actingFor ? {} : { contexts_note: CONTEXTS_NEED_HUMAN }),
      })
    },
  )
}

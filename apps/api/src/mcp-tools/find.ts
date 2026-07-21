import { SKILL_CONTENT_TYPE } from "@derive/core"
import { z } from "zod"
import {
  searchArtifactVersion,
  searchMatcher,
  searchReport,
  searchWorkspace,
  toSearchHits,
} from "../lib/search"
import type { ToolContext } from "../mcp-tool-context"
import { err, json, runnerOnline, summarizeArtifact, text } from "../mcp-util"

// FIND — one tool over BROWSE (list_artifacts) + GREP/SEARCH (search) + the askable
// CONTEXTS (list_contexts), discriminated by argument. The mode is decided by what's
// passed: `short_id` ⇒ grep within it; `query` alone ⇒ search the workspace; neither ⇒
// browse. Result rows are typed (artifact | match | context) so a mixed listing is
// unambiguous. -----------------------------------------------------------------------
const CONTEXTS_NEED_HUMAN =
  "Contexts (askable live data agents) are hidden here: this connection has no signed-in user. Reconnect with an OAuth login to see and use them."

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
          note: "Ask it on your user's behalf with `use` (a question or a commission).",
        }
      }),
    )
  }
  server.registerTool(
    "find",
    {
      description:
        "Find things in Derive — the MODE is decided by what you pass. Pass `short_id` + `query` to GREP within one artifact: matching lines with line numbers (in:'source'|'text', context lines, a past `version`), so you can then read a `lines` range or edit that spot. Pass `query` ALONE to SEARCH the whole workspace — artifacts ranked by relevance with a snippet each, so you find WHICH doc has something before opening it; this ALSO surfaces any askable context whose name matches. Pass NEITHER to BROWSE the library: every artifact (short id, title, kind, is_skill, version, access, tags — skills:true or a `tag` narrows it) PLUS the askable contexts. Rows are typed (artifact | match | context); a context row is reached with `use`, never read/opened. Includes your own unlisted work. For the browse→work rhythm, read derive://skills/loop.",
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
          .describe("Browse only: artifacts carrying this browse tag (case-insensitive)."),
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
        context: z
          .number()
          .optional()
          .describe(
            "Grep/search: lines of surrounding context around each match (default 0, max 5).",
          ),
        max_matches: z
          .number()
          .optional()
          .describe("Grep/search: cap on matches per artifact (default 40, max 200)."),
        version: z
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

      // MODE 3 — BROWSE the library: list_artifacts rows (skills:/tag facets), plus every
      // askable context. A tag filter resolves to an id set first (mirrors the HTTP ?tag=
      // path); viewerId keeps private rows scoped to the agent's human (mirrors `reach`).
      const t = await resolveWs(workspace)
      if ("error" in t) return err(t.error)
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

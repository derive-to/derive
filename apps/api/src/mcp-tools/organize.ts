import { type ArtifactRecord, newId, roleAllows } from "@derive/core"
import { z } from "zod"
import { computeTagSuggestions } from "../lib/tag-suggestions"
import { normalizeTags } from "../lib/tags"
import type { ToolContext } from "../mcp-tool-context"
import { err, json } from "../mcp-util"

export function registerOrganizeTool(tc: ToolContext): void {
  const { server, ctx, agent, actingFor, reach, resolveWs, wsArg } = tc

  // ORGANIZE — ONE tool for the library's findability metadata: tags + collections,
  // read + write. No short_ids ⇒ the workspace overview (vocabulary + collections).
  // short_ids alone ⇒ inspect them (current tags/collections + tag suggestions). Any of
  // add/remove/set/collection ⇒ write. Replaces the old list_tags/suggest_tags/tag/
  // list_collections/collect point-tools.
  server.registerTool(
    "organize",
    {
      description:
        "Tags and collections in one tool — the library's findability layer. READ (no `short_ids`) returns the workspace's tag vocabulary + collections; READ with `short_ids` returns their tags/collections plus suggested tags. WRITE (`add`/`remove`/`set` tags, and/or `collection`) changes them — each artifact is authorized on its own, so ones you can't touch come back skipped, never failing the batch. Tag freely and reuse the vocabulary; a collection is for when a set is a real unit. For the read-vs-write modes and the tags-vs-collections call, read derive://skills/organize.",
      inputSchema: {
        short_ids: z
          .array(z.string())
          .optional()
          .describe("Artifacts to inspect or organize. Omit for the workspace overview."),
        add: z.array(z.string()).optional().describe("Tags to add (union; never drops existing)."),
        remove: z.array(z.string()).optional().describe("Tags to remove."),
        set: z
          .array(z.string())
          .optional()
          .describe("Replace the whole tag set (overrides add/remove)."),
        collection: z
          .string()
          .optional()
          .describe("Fold `short_ids` into this collection — an id, or a name (created if new)."),
        workspace: wsArg,
      },
    },
    async ({ short_ids, add, remove, set, collection, workspace }) => {
      const t = await resolveWs(workspace)
      if ("error" in t) return err(t.error)
      const actorId = actingFor?.id ?? agent.id
      const sortVocab = (v: { tag: string; count: number }[]) =>
        v.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))

      // ---- WRITE: add/remove/set tags and/or fold into a collection ----
      if (add || remove || set || collection) {
        if (!short_ids?.length)
          return err("Pass `short_ids` to organize (with add/remove/set and/or collection).")
        const out: Record<string, unknown> = {}
        if (add || remove || set) {
          const removeSet = new Set(normalizeTags(remove ?? []))
          let updated = 0
          let skipped = 0
          const results: { short_id: string; tags: string[] }[] = []
          for (const shortId of [...new Set(short_ids)]) {
            const reached = await reach(shortId, workspace)
            // Not found or not editable → skipped, never fails the batch.
            if (!reached || "error" in reached || !roleAllows(reached.role, "publish")) {
              skipped++
              continue
            }
            const next = set
              ? normalizeTags(set)
              : normalizeTags([
                  ...((await ctx.meta.tagsForArtifacts([reached.a.id]))[reached.a.id] ?? []),
                  ...(add ?? []),
                ]).filter((x) => !removeSet.has(x))
            await ctx.meta.setArtifactTags(reached.a.id, next)
            updated++
            results.push({ short_id: shortId, tags: next })
          }
          out.tagged = { updated, skipped, results }
        }
        if (collection) {
          // Resolve the target collection: an id, else a name (matched team-visible, else
          // created). Then the caller must be able to MANAGE it (mirrors the HTTP route).
          const ref = collection.trim()
          if (!ref) return err("Pass a non-empty collection name or id.")
          let col = await ctx.meta.getCollection(ref)
          if (col && col.org_id !== t.org) return err("That collection is in another workspace.")
          if (!col) {
            const existing = (
              await Promise.all(
                (
                  await ctx.meta.listCollections(t.org)
                ).map(async (x) => ({
                  x,
                  visible:
                    x.workspace_access === "member" ||
                    x.created_by === actorId ||
                    !!(await ctx.meta.getCollectionMember(x.id, actorId)),
                })),
              )
            ).find(({ x, visible }) => x.title.toLowerCase() === ref.toLowerCase() && visible)?.x
            if (existing) col = existing
            else {
              col = await ctx.meta.createCollection({
                id: newId("col"),
                org_id: t.org,
                title: ref.slice(0, 120),
                created_by: actorId,
                workspace_access: "member",
              })
              await ctx.meta.setCollectionMember({
                id: newId("cm"),
                collection_id: col.id,
                user_id: actorId,
                role: "owner",
              })
            }
          }
          const canManage =
            col.workspace_access === "member"
              ? roleAllows(t.role, "publish")
              : roleAllows(
                  (await ctx.meta.getCollectionMember(col.id, actorId))?.role ?? "viewer",
                  "publish",
                )
          if (!canManage) return err("You can't add to that collection.")
          let added = 0
          let skipped = 0
          for (const shortId of [...new Set(short_ids)]) {
            const reached = await reach(shortId, workspace)
            // Adding to a shared collection re-shares the artifact → needs share standing.
            // `reach` may roam across the grant when `workspace` is omitted, but a collection
            // can contain only artifacts from its own workspace (the HTTP bulk route has the
            // same guard). Without this check, a default-workspace collection could reference
            // an artifact from another workspace the grant can reach.
            if (
              !reached ||
              "error" in reached ||
              reached.org !== t.org ||
              !roleAllows(reached.role, "share")
            ) {
              skipped++
              continue
            }
            await ctx.meta.addCollectionItem(col.id, reached.a.id)
            added++
          }
          out.collected = { collection: { id: col.id, title: col.title }, added, skipped }
        }
        return json(out)
      }

      // ---- READ: inspect specific artifacts (current tags + collections + suggestions) --
      if (short_ids?.length) {
        const artifacts: {
          short_id: string
          tags?: string[]
          collections?: string[]
          error?: string
        }[] = []
        let firstReached: ArtifactRecord | null = null
        for (const shortId of short_ids) {
          const reached = await reach(shortId, workspace)
          if (!reached || "error" in reached) {
            artifacts.push({ short_id: shortId, error: "not reachable" })
            continue
          }
          if (!firstReached) firstReached = reached.a
          const [tagMap, colIds] = await Promise.all([
            ctx.meta.tagsForArtifacts([reached.a.id]),
            ctx.meta.collectionIdsForArtifact(reached.a.id),
          ])
          artifacts.push({
            short_id: shortId,
            tags: tagMap[reached.a.id] ?? [],
            collections: colIds,
          })
        }
        // Suggestions only for a SINGLE artifact — aggregating across many is ambiguous.
        const suggested =
          short_ids.length === 1 && firstReached
            ? (
                await computeTagSuggestions(
                  { meta: ctx.meta, search: ctx.search, sourceText: ctx.sourceText },
                  firstReached,
                  actorId,
                )
              ).suggested
            : undefined
        return json({
          artifacts,
          ...(suggested ? { suggested } : {}),
          vocabulary: sortVocab(await ctx.meta.tagCounts(t.org)).slice(0, 50),
        })
      }

      // ---- READ: workspace overview (vocabulary + collections) ----
      const [tags, cols] = await Promise.all([
        ctx.meta.tagCounts(t.org),
        ctx.meta.listCollections(t.org),
      ])
      const visibleCols = await Promise.all(
        cols.map(async (col) => ({
          col,
          visible:
            col.workspace_access === "member" ||
            col.created_by === actorId ||
            !!(await ctx.meta.getCollectionMember(col.id, actorId)),
        })),
      )
      return json({
        workspace: t.org,
        vocabulary: sortVocab(tags),
        collections: visibleCols
          .filter(({ visible }) => visible)
          .map(({ col }) => ({ id: col.id, title: col.title, count: col.count })),
      })
    },
  )
}

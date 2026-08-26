import { type ArtifactRecord, newId, roleAllows } from "@derive/core"
import { z } from "zod"
import { badChoice, choiceDescription } from "../lib/open-choice"
import { deleteArtifactAndUnindex } from "../lib/search"
import { computeTagSuggestions } from "../lib/tag-suggestions"
import { normalizeTags } from "../lib/tags"
import type { ToolContext } from "../mcp-tool-context"
import { err, json } from "../mcp-util"

/**
 * An open string choice so cached clients accept future states. `removed` retains the
 * legacy tombstone workflow; `deleted` is the existing permanent deletion capability.
 */
const LIBRARY_STATES = ["archived", "removed", "live", "deleted"] as const

/** The union of what the three schemas below accept. Each tool exposes a subset, and that
 *  subset is the entire difference between them. */
type LibraryInput = {
  short_ids?: string[]
  add?: string[]
  remove?: string[]
  set?: string[]
  collection?: string
  state?: string
  workspace?: string
}

/**
 * Tags, collections, and lifecycle state, read and written. One handler for all three
 * library tools: an artifact authorizes the same way whether you are tagging it or
 * retiring it, so the rules live here once and the schemas below decide who may ask for
 * what.
 */
async function organizeCore(tc: ToolContext, input: LibraryInput) {
  const { ctx, agent, actingFor, reach, resolveWs } = tc
  const { short_ids, add, remove, set, collection, state, workspace } = input
  const t = await resolveWs(workspace)
  if ("error" in t) return err(t.error)
  const actorId = actingFor?.id ?? agent.id
  const sortVocab = (v: { tag: string; count: number }[]) =>
    v.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))

  // ---- WRITE: tags, collections, and lifecycle state -----------------
  if (add || remove || set || collection || state) {
    // Shared by `organize` and `shelve`: both require `short_ids` in their schemas, but an
    // empty array satisfies that and would otherwise report a no-op as a success.
    if (!short_ids?.length) return err("Pass at least one artifact in `short_ids`.")
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
    // Lifecycle transitions. `removed` remains for legacy tombstone clients.
    if (state) {
      const wrong = badChoice("state", state, LIBRARY_STATES)
      if (wrong) return err(wrong)
      if (state === "archived") {
        const ids: string[] = []
        const done: string[] = []
        let skipped = 0
        for (const shortId of [...new Set(short_ids)]) {
          const reached = await reach(shortId, workspace)
          if (!reached || "error" in reached || !roleAllows(reached.role, "publish")) {
            skipped++
            continue
          }
          ids.push(reached.a.id)
          done.push(shortId)
        }
        if (ids.length) await ctx.meta.setArtifactsArchived(ids, new Date().toISOString())
        out.state = {
          state,
          changed: ids.length,
          skipped,
          undo: done.length
            ? {
                tool: "shelve",
                arguments: {
                  short_ids: done,
                  state: "live",
                  ...(workspace ? { workspace } : {}),
                },
              }
            : undefined,
          note: "Archived: hidden from the library and search, but still readable at its URL. `state:'live'` restores it.",
        }
        return json(out)
      }
      // Permanent deletion has a manage-level gate and no undo, so it remains separate
      // from reversible state transitions.
      if (state === "deleted") {
        const gone: string[] = []
        const notAllowed: string[] = []
        let skipped = 0
        // Read once for the batch: a context whose manifest is deleted is deleted with
        // it (the FK cascade), so the caller learns what else goes rather than finding
        // out when a runner stops answering.
        const contexts = await ctx.meta.listContexts(t.org).catch(() => [])
        const cascaded: { short_id: string; context: string }[] = []
        for (const shortId of [...new Set(short_ids)]) {
          const reached = await reach(shortId, workspace, { allowRemoved: true })
          if (!reached || "error" in reached) {
            skipped++
            continue
          }
          if (!roleAllows(reached.role, "manage")) {
            notAllowed.push(shortId)
            skipped++
            continue
          }
          for (const cx of contexts)
            if (cx.manifest_artifact_id === reached.a.id)
              cascaded.push({ short_id: shortId, context: cx.name })
          // The one helper, so a hard delete can't clean the lexical index and forget
          // the dense vector (or vice versa) — see lib/search.ts.
          await deleteArtifactAndUnindex(ctx.meta, ctx.deps.search, reached.a.id, t.org)
          gone.push(shortId)
        }
        out.state = {
          state,
          deleted: gone.length,
          skipped,
          note: gone.length
            ? "Permanently deleted, with every version and comment. This cannot be undone — `state:'archived'` is the reversible option if that is what you wanted."
            : "Nothing was deleted.",
          ...(cascaded.length
            ? {
                cascaded_contexts: cascaded,
                cascaded_contexts_note:
                  "These contexts ran from the deleted manifests and are gone with them. A context cannot outlive its definition.",
              }
            : {}),
          ...(notAllowed.length
            ? {
                needs_manage: notAllowed,
                needs_manage_note:
                  "Deleting permanently needs a manage-level grant on the artifact, a higher bar than publishing to it. `state:'archived'` hides these reversibly at your current role.",
              }
            : {}),
        }
        return json(out)
      }
      const removedAt = state === "removed" ? new Date().toISOString() : null
      const ok: string[] = []
      const archivedOk: string[] = []
      const done: string[] = []
      const moderated: string[] = []
      const wiredTo: { short_id: string; context: string }[] = []
      let skipped = 0
      // Removing a context manifest leaves the context configured but unreadable. Load
      // contexts once so the response can identify every affected context.
      const contexts = state === "removed" ? await ctx.meta.listContexts(t.org).catch(() => []) : []
      for (const shortId of [...new Set(short_ids)]) {
        // Restoration must resolve tombstones while retaining workspace and role checks.
        const reached = await reach(shortId, workspace, { allowRemoved: true })
        if (!reached || "error" in reached || !roleAllows(reached.role, "publish")) {
          skipped++
          continue
        }
        if (state === "live" && reached.a.archived_at && !reached.a.removed_at) {
          archivedOk.push(reached.a.id)
          done.push(shortId)
          continue
        }
        // Editors cannot reverse moderation takedowns. The audit log distinguishes a
        // takedown from an author-initiated retirement.
        if (state === "live" && !roleAllows(reached.role, "manage")) {
          const log = await ctx.meta
            .listAuditLog(t.org, { artifactId: reached.a.id, limit: 20 })
            .catch(() => [])
          // Logs are newest first; the first matching entry is the standing decision.
          const standing = log.find((e) => e.action === "takedown" || e.action === "reinstate")
          if (standing?.action === "takedown") {
            moderated.push(shortId)
            skipped++
            continue
          }
        }
        ok.push(reached.a.id)
        done.push(shortId)
        for (const cx of contexts)
          if (cx.manifest_artifact_id === reached.a.id)
            wiredTo.push({ short_id: shortId, context: cx.name })
      }
      // Apply each state transition with one batch update.
      if (ok.length) await ctx.meta.setArtifactsRemoved(ok, removedAt)
      if (archivedOk.length) await ctx.meta.setArtifactsArchived(archivedOk, null)
      out.state = {
        state,
        changed: ok.length + archivedOk.length,
        skipped,
        // Undo includes only artifacts that changed.
        undo:
          done.length && !(state === "live" && ok.length > 0 && archivedOk.length > 0)
            ? {
                tool: "shelve",
                arguments: {
                  short_ids: done,
                  state: state === "removed" ? "live" : archivedOk.length ? "archived" : "removed",
                  ...(workspace ? { workspace } : {}),
                },
              }
            : undefined,
        ...(wiredTo.length
          ? {
              in_use_by_contexts: wiredTo,
              in_use_by_contexts_note:
                "These are the manifests live contexts run from. The context stays askable, and its runner will fail reading the manifest rather than at the moment you retired it. Retire the context too, or put the manifest back.",
            }
          : {}),
        ...(moderated.length
          ? {
              moderation_hold: moderated,
              moderation_hold_note:
                "These were taken down by moderation, not retired by an author. Restoring one is an admin decision — it reopens content someone removed deliberately — so it needs a manage-level grant.",
            }
          : {}),
        note:
          state === "removed"
            ? "Retired from the library: the url now reads as removed. Nothing is deleted, and `state:'live'` puts it back."
            : "Back in the library.",
      }
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
}

// Three tools over the handler above. They are split by ANNOTATION, not by feature:
// clients gate on readOnlyHint / destructiveHint, so a tool that can permanently delete
// must declare itself destructive across everything else it does too. Folding these back
// into one would put the library's reads behind the prompt `state:'deleted'` earns —
// which is what `organize` alone used to do.
//
// They differ ONLY in which arguments their schemas accept. organizeCore routes on which
// arrived, so the guards, cascades and response shapes are shared.

/** READ. No `short_ids` ⇒ the workspace vocabulary + collections; with them ⇒ each
 *  artifact's tags, collections and (for a single one) suggestions. */
export function registerBrowseLibraryTool(tc: ToolContext): void {
  tc.server.registerTool(
    "browse_library",
    {
      description:
        "Read the library's metadata. No `short_ids` returns the workspace tag vocabulary and its collections; with them, each artifact's tags and collections.",
      annotations: {
        title: "Browse the library",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        short_ids: z
          .array(z.string())
          .optional()
          .describe("Artifacts to inspect. Omit for the workspace overview."),
        workspace: tc.wsArg,
      },
    },
    async ({ short_ids, workspace }) => organizeCore(tc, { short_ids, workspace }),
  )
}

/** WRITE, non-destructive: tags and collections. Lifecycle state lives on `shelve`, so
 *  nothing reachable from here can lose an artifact — which is what earns the
 *  destructiveHint: false below. */
export function registerOrganizeTool(tc: ToolContext): void {
  tc.server.registerTool(
    "organize",
    {
      description:
        "Tag artifacts and fold them into collections. Each artifact authorizes on its own, so untouchable ones come back skipped. Retiring or deleting is `shelve`. See derive://skills/organize.",
      annotations: {
        title: "Organize the library",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        // OPTIONAL although every call needs it. `organize` predates the split, so stale
        // schemas are in the wild; leaving this required would have zod refuse those calls
        // with "expected array" before the handler could say where the capability went.
        // Optional keeps them arriving at the refusal below, which steers. The handler is
        // what enforces it — see the empty-batch check in organizeCore.
        short_ids: z.array(z.string()).optional().describe("Artifacts to tag or collect."),
        add: z.array(z.string()).optional(),
        remove: z.array(z.string()).optional(),
        set: z.array(z.string()).optional(),
        collection: z
          .string()
          .optional()
          .describe("Fold `short_ids` into this collection — an id, or a name (created if new)."),
        workspace: tc.wsArg,
      },
    },
    async ({ short_ids, add, remove, set, collection, workspace }) => {
      // No verb ⇒ the core would fall through to its read path, leaving a read reachable
      // through the tool that declares itself a write. Refused here instead, and the refusal
      // names BOTH neighbours because it cannot tell which one the caller wanted: `organize`
      // predates the split, so a stale schema still offers `state`, and zod strips it before
      // the handler ever sees it. A caller who asked to delete arrives here indistinguishable
      // from one who asked to read.
      if (!add && !remove && !set && !collection)
        return err(
          "Pass add/remove/set or `collection`. Reading is `browse_library`; retiring or deleting is `shelve`.",
        )
      return organizeCore(tc, { short_ids, add, remove, set, collection, workspace })
    },
  )
}

/** DESTRUCTIVE. Retire, restore, and permanently delete. Retire and restore stay together
 *  deliberately: split them and you get a surface that can retire something with no obvious
 *  way back. The response carries its own undo for every state except `deleted`. */
export function registerShelveTool(tc: ToolContext): void {
  tc.server.registerTool(
    "shelve",
    {
      description:
        "Retire artifacts from the library, restore them, or delete them permanently. state:'deleted' is irreversible and needs a manage grant; state:'archived' hides them reversibly. See derive://skills/organize.",
      annotations: {
        title: "Retire or delete artifacts",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        short_ids: z.array(z.string()).describe("Artifacts to retire, restore, or delete."),
        // min(1) is load-bearing, not decoration: the core treats a falsy `state` as "no
        // lifecycle verb" and falls through to its read path, so an empty string here would
        // return the library read through the tool that declares itself destructive.
        state: z
          .string()
          .min(1)
          .describe(
            choiceDescription(
              LIBRARY_STATES,
              "Archive these from the library, restore them, or permanently delete them.",
            ),
          ),
        workspace: tc.wsArg,
      },
    },
    async ({ short_ids, state, workspace }) => organizeCore(tc, { short_ids, state, workspace }),
  )
}

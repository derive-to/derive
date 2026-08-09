import { type ArtifactRecord, type CollectionRecord, newId, roleAllows } from "@derive/core"
import { z } from "zod"
import { badChoice, choiceDescription } from "../lib/open-choice"
import { deleteArtifactAndUnindex } from "../lib/search"
import { computeTagSuggestions } from "../lib/tag-suggestions"
import { normalizeTags } from "../lib/tags"
import type { ToolContext } from "../mcp-tool-context"
import { err, json } from "../mcp-util"

/** Whether an artifact is in the library, retired from it, or gone for good. A growth
 *  point (an `archived` tier is the obvious next one), so a string checked server-side
 *  rather than an enum a cached client would refuse — see lib/open-choice.ts.
 *
 *  `deleted` is NOT a third shelf: it is the permanent one, and it is here because the
 *  capability already existed at REST (DELETE /v1/artifacts/:id, same manage gate) and was
 *  simply unreachable from the tool an agent tidies its library with. Parity, not new
 *  power — the alternative was minting a REST credential to finish a cleanup you started
 *  in `organize`. */
const LIBRARY_STATES = ["removed", "live", "deleted"] as const

export function registerOrganizeTool(tc: ToolContext): void {
  const { server, ctx, agent, actingFor, reach, resolveWs, wsArg } = tc

  // ORGANIZE — ONE tool for the library's findability metadata: tags + collections,
  // read + write. No short_ids ⇒ the workspace overview (vocabulary + collections).
  // short_ids alone ⇒ inspect them (current tags/collections + tag suggestions). Any of
  // add/remove/set/collection/uncollect ⇒ write. Replaces the old list_tags/suggest_tags/tag/
  // list_collections/collect point-tools.
  server.registerTool(
    "organize",
    {
      description:
        "Tags, collections and shelving. No `short_ids` reads the workspace vocabulary; with them, writes tags/`collection`/`uncollect`/`state`. Each artifact authorizes on its own, so untouchable ones come back skipped. state:'deleted' is permanent. See derive://skills/organize.",
      // Tag/collection edits are reversible (add/remove/set, fold into a collection), and
      // `state:'removed'` is an explicitly reversible retire — but `state:'deleted'` is a
      // real permanent delete (every version, comment and proposal, cascading to any
      // context whose manifest it was — "This cannot be undone"), so destructive has to
      // be true for the tool as a whole. Derive's own backend only.
      annotations: {
        title: "Organize the library",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        short_ids: z
          .array(z.string())
          .optional()
          .describe("Artifacts to inspect or organize. Omit for the workspace overview."),
        add: z.array(z.string()).optional(),
        remove: z.array(z.string()).optional(),
        set: z.array(z.string()).optional(),
        collection: z
          .string()
          .optional()
          .describe("Fold `short_ids` into this collection — an id, or a name (created if new)."),
        // The way back out of `collection`. Same shape and the same bar as folding in, so
        // an artifact filed into the wrong collection is never stuck there.
        uncollect: z
          .string()
          .optional()
          .describe("Pull `short_ids` back out of this collection — an id, or a name."),
        // Both directions on ONE parameter, deliberately. Remove and undo are the same
        // decision read in two directions, and splitting them across two actions (or two
        // tools) is how you end up with a surface that can retire something and no obvious
        // way back.
        state: z
          .string()
          .optional()
          .describe(
            choiceDescription(
              LIBRARY_STATES,
              "Retire these from the library, or restore ones already retired. Reversible either way.",
            ),
          ),
        workspace: wsArg,
      },
    },
    async ({ short_ids, add, remove, set, collection, uncollect, state, workspace }) => {
      const t = await resolveWs(workspace)
      if ("error" in t) return err(t.error)
      const actorId = actingFor?.id ?? agent.id
      const sortVocab = (v: { tag: string; count: number }[]) =>
        v.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))

      // ---- WRITE: add/remove/set tags, fold into a collection, and/or shelve ----
      if (add || remove || set || collection || uncollect || state) {
        if (!short_ids?.length)
          return err(
            "Pass `short_ids` to organize (with add/remove/set, collection/uncollect and/or state).",
          )
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
        // Resolve a collection ref: an id, else a name matched among team-visible ones.
        // Shared by both directions; only `collection` creates a missing one.
        const findCollection = async (
          ref: string,
        ): Promise<CollectionRecord | "foreign" | null> => {
          const byId = await ctx.meta.getCollection(ref)
          if (byId) return byId.org_id === t.org ? byId : "foreign"
          return (
            (
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
            ).find(({ x, visible }) => x.title.toLowerCase() === ref.toLowerCase() && visible)?.x ??
            null
          )
        }
        // The caller must be able to MANAGE the collection (mirrors the HTTP routes) — the
        // SAME bar in both directions, so `uncollect` never reaches wider than `collection`.
        const canManageCollection = async (col: CollectionRecord) =>
          col.workspace_access === "member"
            ? roleAllows(t.role, "publish")
            : roleAllows(
                (await ctx.meta.getCollectionMember(col.id, actorId))?.role ?? "viewer",
                "publish",
              )
        if (collection) {
          const ref = collection.trim()
          if (!ref) return err("Pass a non-empty collection name or id.")
          let col = await findCollection(ref)
          if (col === "foreign") return err("That collection is in another workspace.")
          if (!col) {
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
          if (!(await canManageCollection(col))) return err("You can't add to that collection.")
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
        // UNCOLLECT — the removal `collection` was missing. Same resolution, same manage
        // bar; removing only ever narrows reach, so no per-artifact share gate (matching
        // the HTTP DELETE items route). `allowRemoved` because pulling a retired artifact
        // out of a collection is exactly the cleanup this exists for.
        if (uncollect) {
          const ref = uncollect.trim()
          if (!ref) return err("Pass a non-empty collection name or id.")
          const col = await findCollection(ref)
          if (col === "foreign") return err("That collection is in another workspace.")
          if (!col) return err("No collection by that name or id here.")
          if (!(await canManageCollection(col)))
            return err("You can't remove from that collection.")
          let removed = 0
          let skipped = 0
          for (const shortId of [...new Set(short_ids)]) {
            const reached = await reach(shortId, workspace, { allowRemoved: true })
            if (!reached || "error" in reached || reached.org !== t.org) {
              skipped++
              continue
            }
            await ctx.meta.removeCollectionItem(col.id, reached.a.id)
            removed++
          }
          out.uncollected = { collection: { id: col.id, title: col.title }, removed, skipped }
        }
        // SHELVE / UNSHELVE. Both directions on one parameter: an artifact retired with
        // `state:"removed"` comes back with `state:"live"`, and the response says so, so
        // the way back is never something you have to already know.
        //
        // The tombstone itself is old — sync retires an artifact whose file was deleted,
        // moderation takes one down, PR-preview teardown sweeps a batch. What never existed
        // was an AUTHORING path: the subsystems could retire an artifact and the person who
        // made it could not. This is that path, and nothing more.
        if (state) {
          const wrong = badChoice("state", state, LIBRARY_STATES)
          if (wrong) return err(wrong)
          // PERMANENT DELETE. Split from the shelving path below rather than folded into
          // it, because almost everything about it differs: a MANAGE bar instead of
          // publish (matching the REST route this reaches, and right for something with
          // no way back), a cascade that takes contexts and comments with it, and no
          // `undo` — the one thing this response must never imply it has.
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
              // Said plainly and first: there is no undo, and the response does not carry
              // one. Every other state change here hands back its reversal; pretending
              // this one has a way back would be the most expensive lie on the surface.
              note: gone.length
                ? "Permanently deleted, with every version, comment and proposal. This cannot be undone — `state:'removed'` is the reversible option if that is what you wanted."
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
                      "Deleting permanently needs a manage-level grant on the artifact, a higher bar than publishing to it. `state:'removed'` retires these reversibly at your current role.",
                  }
                : {}),
            }
            return json(out)
          }
          const removedAt = state === "removed" ? new Date().toISOString() : null
          const ok: string[] = []
          const done: string[] = []
          const synced: string[] = []
          const moderated: string[] = []
          const wiredTo: { short_id: string; context: string }[] = []
          let skipped = 0
          // Fetched ONCE for the batch, not per artifact. A context cannot outlive its
          // manifest — hard delete cascades it away deliberately — but shelving is not a
          // delete, so the context stays askable and its runner walks into a takedown
          // error minutes later, in a different process, with nothing linking back to
          // this call. Retiring one is still allowed (decommissioning a context is a real
          // thing to want); it just never happens quietly.
          const contexts =
            state === "removed" ? await ctx.meta.listContexts(t.org).catch(() => []) : []
          for (const shortId of [...new Set(short_ids)]) {
            // Sees past the takedown gate on purpose: this operates on that flag, so the
            // ordinary content gate would hide the artifact being restored. Workspace,
            // membership and role are all still enforced.
            const reached = await reach(shortId, workspace, { allowRemoved: true })
            // Same bar as editing an artifact's content, deliberately: this is reversible,
            // so it does not warrant a higher one than the publish that created it.
            if (!reached || "error" in reached || !roleAllows(reached.role, "publish")) {
              skipped++
              continue
            }
            // A MODERATION takedown is not yours to reverse. `removed_at` carries two very
            // different meanings — "I retired my own draft" and "an admin took this down" —
            // and the moderation path sets it at MANAGE grade, writes an audit row, and
            // resolves every open report in one transaction. Clearing it at the editor bar
            // would undo all three silently, put abusive or DMCA'd content back, and leave
            // the reports closed so it never resurfaces in the queue. The audit log is the
            // only record of which meaning applies, so a restore consults it and defers.
            if (state === "live" && !roleAllows(reached.role, "manage")) {
              const log = await ctx.meta
                .listAuditLog(t.org, { artifactId: reached.a.id, limit: 20 })
                .catch(() => [])
              // Newest first, so the first takedown/reinstate is the standing decision.
              const standing = log.find((e) => e.action === "takedown" || e.action === "reinstate")
              if (standing?.action === "takedown") {
                moderated.push(shortId)
                skipped++
                continue
              }
            }
            ok.push(reached.a.id)
            done.push(shortId)
            // A repo-synced artifact is not really yours to retire: sync clears this exact
            // flag whenever the file changes (lib/sync.ts), so it comes back with nothing
            // to explain why. Allowed, because the tombstone is still what you asked for
            // today, but SAID, because a silent resurrection is the surprise this whole
            // change exists to remove.
            if (reached.a.source_path) synced.push(shortId)
            for (const cx of contexts)
              if (cx.manifest_artifact_id === reached.a.id)
                wiredTo.push({ short_id: shortId, context: cx.name })
          }
          // One update for the batch, per the store's own guidance, rather than a call per id.
          if (ok.length) await ctx.meta.setArtifactsRemoved(ok, removedAt)
          out.state = {
            state,
            changed: ok.length,
            skipped,
            // The reversal, handed back at the moment it might be wanted — naming only what
            // actually changed. Echoing the whole input would tell you to restore artifacts
            // that were skipped and never retired, which is an undo that does not describe
            // the thing it claims to reverse.
            undo: done.length
              ? {
                  tool: "organize",
                  arguments: {
                    short_ids: done,
                    state: state === "removed" ? "live" : "removed",
                    ...(workspace ? { workspace } : {}),
                  },
                }
              : undefined,
            // Named separately from `note` so it cannot be mistaken for the ordinary
            // outcome: this is the one case where the retirement does not stay put.
            // Called out by name: "skipped" alone would read as a permission problem the
            // caller could fix, and this one they should not.
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
            ...(state === "removed" && synced.length
              ? {
                  synced_from_repo: synced,
                  synced_from_repo_note:
                    "These are synced from a repository, and a sync that sees their file change will clear the retirement. To retire one for good, remove the file at the source.",
                }
              : {}),
            note:
              state === "removed"
                ? "Retired from the library: the url now reads as removed. Nothing is deleted, and `state:'live'` puts it back."
                : "Back in the library and readable again.",
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
    },
  )
}

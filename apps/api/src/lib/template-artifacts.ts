// The template shelf: artifacts carrying the `template` tag, in two visibility-filtered
// reads. A template is not its own kind — it is an ordinary artifact (page, bundle,
// skill, linked bundle) that someone tagged as a starting point — so everything the
// shelf shows (URL, versions, preview, author, "Make a copy") is the artifact machinery.
//
// Two shelves, one tag:
//   workspace — the caller's active workspace's tagged artifacts, at the caller's reach
//   public    — tagged artifacts anyone can open (`listed: public` with a world link),
//               from every OTHER workspace
//
// Both are ONE `listArtifacts` read each, with the tag matched in the query (`tag`), so
// the store sorts, caps, and applies the one visibility rule (private rows only for their
// members, tombstones dropped, archive excluded) in the same statement. The public read
// deliberately omits `orgId`: it is the cross-workspace catalog, and `publicOnly` is what
// keeps it to rows the world can open. The password rule is lib/visibility.ts's: a locked
// world link is readable only through a seat, so a locked row stays on the workspace
// shelf only when the seat reaches it (`workspace_access: member`) and never on the
// public shelf.
import type { ArtifactRecord, MetaStore } from "@derive/core"

export const TEMPLATE_TAG = "template"

/** Rows per shelf. The route is open to anonymous callers and the tag is uncurated, so
 *  each shelf is one bounded read; past the cap the caller is told `truncated`, and the
 *  rows that made it are the newest-updated ones, not an arbitrary slice. */
export const TEMPLATE_SHELF_CAP = 90

export type TemplateShelf = "workspace" | "public"

export interface TemplateArtifact {
  artifact: ArtifactRecord
  shelf: TemplateShelf
}

export interface TemplateShelves {
  /** Workspace shelf first, then public; each shelf newest-updated first. */
  rows: TemplateArtifact[]
  /** A shelf had more matching rows than the cap; the newest made it. */
  truncated: boolean
}

export interface ListTemplateArtifactsOpts {
  /** The caller's active workspace; absent for an anonymous caller (public shelf only). */
  orgId?: string | null
  /** Who is reading: a user id, an agent's registrant, or the agent itself. Absent with a
   *  present `orgId` means a trusted operator read (every row in the workspace). */
  viewerId?: string
  /** The caller holds no seat in `orgId` (anonymous, or a non-member): public shelf only. */
  publicOnly?: boolean
  /** Narrow both shelves by title or tag before the cap, so a refined query reaches rows
   *  a full shelf would have cut. */
  query?: string
}

type Store = Pick<MetaStore, "listArtifacts">

/** visibility.ts's predicate: a locked world link counts only where a seat reaches it. */
const reachableDespiteLock = (a: ArtifactRecord, shelf: TemplateShelf): boolean =>
  !a.password_hash || (shelf === "workspace" && a.workspace_access === "member")

/**
 * Every template artifact this caller may see, workspace shelf first, each shelf newest
 * updated first. Never throws on an empty tag: no tagged artifacts is an empty shelf.
 */
export const listTemplateArtifacts = async (
  meta: Store,
  opts: ListTemplateArtifactsOpts,
): Promise<TemplateShelves> => {
  const needle = opts.query?.trim()
  const common = {
    tag: TEMPLATE_TAG,
    ...(needle ? { q: needle, collectionSearchViewerId: null } : {}),
    archived: "exclude" as const,
    excludeRemoved: true,
    sort: "updated" as const,
    limit: TEMPLATE_SHELF_CAP + 1,
  }

  const seated = !!opts.orgId && !opts.publicOnly
  const workspaceAll = (
    seated
      ? await meta.listArtifacts({
          ...common,
          orgId: opts.orgId ?? undefined,
          viewerId: opts.viewerId,
        })
      : []
  ).filter((a) => reachableDespiteLock(a, "workspace"))
  const workspaceRows = workspaceAll.slice(0, TEMPLATE_SHELF_CAP)

  // The public read is the cross-workspace catalog. A seated caller's own rows belong on
  // the workspace shelf (where they are, or fell past its cap), never labelled public.
  const publicAll = (await meta.listArtifacts({ ...common, publicOnly: true })).filter(
    (a) => reachableDespiteLock(a, "public") && !(seated && a.org_id === opts.orgId),
  )
  const publicRows = publicAll.slice(0, TEMPLATE_SHELF_CAP)

  return {
    rows: [
      ...workspaceRows.map((artifact) => ({ artifact, shelf: "workspace" as const })),
      ...publicRows.map((artifact) => ({ artifact, shelf: "public" as const })),
    ],
    truncated: workspaceAll.length > TEMPLATE_SHELF_CAP || publicAll.length > TEMPLATE_SHELF_CAP,
  }
}

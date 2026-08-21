// The template shelf: artifacts carrying the `template` tag, read at the caller's reach.
//
//   workspace — the caller's workspace, viewer-scoped
//   public    — `listed: public` rows from every other workspace
//
// One `listArtifacts` per shelf, with the tag matched in the query (`tag`) so the store
// sorts, caps, and applies the listing gate in the same statement. The public read omits
// `orgId` on purpose: it is the cross-workspace catalog, and `publicOnly` is what keeps
// it to rows the world can open. The lock rule is lib/visibility.ts's: a password-locked
// world link is readable only through a seat.
import type { ArtifactRecord, MetaStore } from "@derive/core"

export const TEMPLATE_TAG = "template"

/** Rows per shelf. Each shelf is one sorted, capped read; `truncated` reports the cut. */
export const TEMPLATE_SHELF_CAP = 90

export type TemplateShelf = "workspace" | "public"

export interface TemplateArtifact {
  artifact: ArtifactRecord
  shelf: TemplateShelf
}

export interface TemplateShelves {
  /** Workspace shelf first, then public; each newest-updated first. */
  rows: TemplateArtifact[]
  /** A shelf had more rows than the cap; the newest made it. */
  truncated: boolean
}

export interface ListTemplateArtifactsOpts {
  /** The caller's seat. Omit for the public shelf alone (anonymous, or no seat in the
   *  active workspace). `viewerId` omitted means a trusted read of the whole workspace. */
  workspace?: { orgId: string; viewerId?: string }
  /** Narrows both shelves by title or tag before the cap. */
  query?: string
}

const lockPermits = (a: ArtifactRecord, shelf: TemplateShelf): boolean =>
  !a.password_hash || (shelf === "workspace" && a.workspace_access === "member")

export const listTemplateArtifacts = async (
  meta: Pick<MetaStore, "listArtifacts">,
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
  const seat = opts.workspace

  const workspaceAll = (
    seat ? await meta.listArtifacts({ ...common, orgId: seat.orgId, viewerId: seat.viewerId }) : []
  ).filter((a) => lockPermits(a, "workspace"))

  // A seated caller's own rows belong on the workspace shelf, whether they made its cap
  // or not; they are never relabelled public.
  const publicAll = (await meta.listArtifacts({ ...common, publicOnly: true })).filter(
    (a) => lockPermits(a, "public") && a.org_id !== seat?.orgId,
  )

  return {
    rows: [
      ...workspaceAll.slice(0, TEMPLATE_SHELF_CAP).map((artifact) => ({
        artifact,
        shelf: "workspace" as const,
      })),
      ...publicAll.slice(0, TEMPLATE_SHELF_CAP).map((artifact) => ({
        artifact,
        shelf: "public" as const,
      })),
    ],
    truncated: workspaceAll.length > TEMPLATE_SHELF_CAP || publicAll.length > TEMPLATE_SHELF_CAP,
  }
}

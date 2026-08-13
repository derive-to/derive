import type { CollectionPreview, CollectionRecord, Role, WorkspaceSummary } from "@derive/core"
import { z } from "@hono/zod-openapi"
import { BrandprintSchema } from "../schemas"
import { DEFAULT_WORKSPACE_NAME } from "./http"

/** The boot payload's shared shapes: the response schemas and pure mappers used by BOTH
 *  the individual boot routes (tags, collections, settings, notifications) and the
 *  batched GET /v1/bootstrap — moved here (not copied) so the two paths literally
 *  cannot drift. Every schema keeps its registered OpenAPI name, so generated client
 *  types are unchanged. */

export const OrgSettings = z
  .object({
    emailNotifications: z.boolean().describe("When true, send workspace email notifications."),
    githubPostComments: z
      .boolean()
      .describe("When true, post Derive comments onto the linked GitHub PR."),
    githubMirrorComments: z
      .boolean()
      .describe("When true, mirror GitHub PR comments back into Derive."),
    githubPreviewLink: z
      .boolean()
      .describe("When true, add a preview link to the linked GitHub PR."),
    // The access a NEW publish lands with (see access-model.md): the three
    // single-purpose fields. Factory default is the team draft — member / none / none.
    defaultWorkspaceAccess: z
      .enum(["none", "member"])
      .describe("Access a new publish lands with: none, or member (factory default)."),
    defaultLinkRole: z
      .enum(["none", "viewer", "commenter", "editor"])
      .describe("Share-link role a new publish lands with (factory default: none)."),
    defaultListed: z
      .enum(["none", "workspace", "public"])
      .describe("Listing a new publish lands with: none (default), workspace, or public."),
    whiteLabel: z
      .boolean()
      .describe(
        "Hide the Made-with-Derive marks on public artifacts and embeds, and honor the bare ?chrome=none embed.",
      ),
    hostedAgentsEnabled: z
      .boolean()
      .describe("Master switch for Derive-hosted agent runs; off silences every hosted run."),
    chatBeta: z
      .boolean()
      .describe(
        "The Chat tab on a document, and the workspace chat. ON by default; set it false to turn chat off for a workspace entirely (the tab hides and the chat routes refuse).",
      ),
    chatSources: z
      .array(z.string())
      .describe(
        "Connection ids the workspace's CHAT may reach through the call tool. Empty means none — connecting a server does not by itself let a conversation use it. Unattended runs are unaffected: they declare their own connections per run.",
      ),
    automateBeta: z
      .boolean()
      .describe(
        "BETA: automations on a document. Off by default — the Automate entry point is hidden and the create/run/fire routes refuse, so a workspace opts in deliberately.",
      ),
    agentKillswitch: z
      .boolean()
      .describe("When true, every hosted agent write demotes to a proposal, instantly."),
    agentAutoEnabled: z
      .boolean()
      .describe("Opt-in for autonomy 'auto' to live-publish (always with a review round)."),
    defaultAgentId: z
      .string()
      .optional()
      .describe(
        "The workspace's default agent: the fallback actor for users with no connected agent. Absent = none.",
      ),
    brandprint: BrandprintSchema.optional().describe(
      "The workspace's Brandprint (conventions collection + brand-profile artifact); absent until set.",
    ),
  })
  .openapi("OrgSettings")

export const Notification = z
  .object({
    id: z.string(),
    user_id: z.string().describe("The recipient this notification belongs to"),
    actor: z.string().describe("Who triggered it; for follow/publish this is the person's @handle"),
    kind: z
      .enum(["mention", "comment", "share", "follow", "publish", "review"])
      .describe("What happened: mention, comment, share, follow, publish, or review"),
    artifact_id: z.string(),
    artifact_short_id: z
      .string()
      .describe("The artifact's public short id for links; empty for follows (no anchor)"),
    artifact_title: z
      .string()
      .nullable()
      .describe("The artifact's title, or null if untitled or not artifact-anchored"),
    thread_id: z.string().describe("The comment thread anchor; empty when not comment-related"),
    comment_id: z.string().describe("The specific comment anchor; empty when not comment-related"),
    preview: z.string().describe("Short text preview shown in the notification bell"),
    read: z
      .union([z.literal(0), z.literal(1)])
      .describe("Whether the user has read it: 0 unread, 1 read"),
    created_at: z.string(),
  })
  .openapi("Notification")

// A collection as it goes out: the stored row + its item `count` + where it came from
// (`kind` = manual/repo/pr, with the repo/PR details). Origin is DERIVED here, not
// stored. Every collection-returning endpoint emits this one shape.
/** How far back "worked in" looks. Long enough that a fortnight away doesn't empty your
 *  sidebar, short enough that a shelf you finished with drops off on its own. One
 *  definition, so the list read and the boot batch can't disagree about what active means. */
export const ACTIVE_WINDOW_DAYS = 30
/** How many covers a shelf shows before "+N". Four reads as a strip; more turns the row
 *  into a listing and starts costing real preview bytes. */
export const PREVIEW_PER_COLLECTION = 4
export const activeSince = (): string =>
  new Date(Date.now() - ACTIVE_WINDOW_DAYS * 86400_000).toISOString()

export const Collection = z
  .object({
    id: z.string(),
    title: z.string(),
    created_by: z.string().describe('Creator\'s user id ("anon" if created anonymously).'),
    created_at: z.string(),
    count: z.number().describe("Number of artifacts in the collection."),
    workspace_access: z
      .enum(["none", "member"])
      .optional()
      .describe('Workspace share scope: "member" (all members) or "none" (invite-only).'),
    link_role: z
      .enum(["none", "viewer", "commenter", "editor"])
      .optional()
      .describe("What merely holding the canonical collection link grants."),
    password_protected: z
      .boolean()
      .optional()
      .describe("Whether the collection world link requires a password."),
    url: z.string().optional().describe("Canonical share URL for this collection."),
    my_role: z
      .enum(["viewer", "commenter", "editor", "owner"])
      .nullable()
      .optional()
      .describe("Caller's effective role on the collection. Null if none."),
    can_share: z
      .boolean()
      .optional()
      .describe(
        "Whether the caller has standing (not merely a world-link role) to change collection sharing.",
      ),
    starred: z
      .boolean()
      .optional()
      .describe("Whether the caller starred this collection — it pins to their sidebar."),
    /** Newest activity among the collection's artifacts. Derived from the preview strip
     *  rather than stored — a collection has no mtime of its own. */
    last_activity: z.string().optional(),
    /** The CALLER's latest touch here (publish or comment, being added counts) within
     *  the active window — what the Collections digest orders "your shelves" by. */
    my_last_activity: z.string().optional(),
    preview: z
      .array(
        z.object({
          short_id: z.string(),
          title: z.string().nullable(),
          current_version: z.number(),
          has_preview: z.boolean(),
          updated_at: z.string(),
          author_name: z.string().nullable(),
          author_login: z.string().nullable(),
          author_avatar: z.string().nullable(),
        }),
      )
      .optional()
      .describe(
        "A few of the collection's most recent artifacts, for the filmstrip the Collections view renders. A preview strip, not a listing.",
      ),
    active: z
      .boolean()
      .optional()
      .describe(
        "Whether the caller has worked in this collection recently — published, commented, or been added. Derived from acts that leave a row; reading is not recorded.",
      ),
    kind: z
      .enum(["manual", "repo", "pr"])
      .optional()
      .describe('Origin: "manual" (user-made), "repo" (GitHub mirror), or "pr" (PR preview).'),
    parentId: z
      .string()
      .optional()
      .describe("For a PR preview: the repo collection it nests under, when connected."),
    prNumber: z.number().optional().describe("For a PR preview: the pull-request number."),
    repo: z.string().optional().describe('For repo/PR collections: the "owner/name" slug.'),
  })
  .openapi("Collection")

// A repo_source links a collection to a "owner/name" repo; pr_number null = the branch
// mirror (the parent), set = a PR preview (a child). Built once, shared by every path
// that enriches a collection so the origin logic lives in one place.
export type Src = { repo: string; pr: number | null }
export const sourceMaps = (
  sources: { collection_id: string; repo: string; pr_number: number | null }[],
) => {
  const srcByCollection = new Map<string, Src>()
  const branchByRepo = new Map<string, string>()
  for (const s of sources) {
    srcByCollection.set(s.collection_id, { repo: s.repo, pr: s.pr_number })
    if (s.pr_number === null) branchByRepo.set(s.repo, s.collection_id)
  }
  return { srcByCollection, branchByRepo }
}
export const enrich = (
  col: CollectionRecord & {
    count: number
    my_role: Role | null
    starred?: boolean
    active?: boolean
    last_activity?: string
    my_last_activity?: string
    preview?: {
      short_id: string
      title: string | null
      current_version: number
      has_preview: boolean
      updated_at: string
      author_name: string | null
      author_login: string | null
      author_avatar: string | null
    }[]
  },
  srcByCollection: Map<string, Src>,
  branchByRepo: Map<string, string>,
) => {
  // `password_hash` is authorization material, never wire data. Every collection
  // response goes through this mapper, so one omission protects list, bootstrap,
  // create, rename, and public detail together.
  const { password_hash, ...safe } = col
  const publicCol = { ...safe, password_protected: !!password_hash }
  const src = srcByCollection.get(col.id)
  if (!src) return { ...publicCol, kind: "manual" as const }
  if (src.pr === null) return { ...publicCol, kind: "repo" as const, repo: src.repo }
  return {
    ...publicCol,
    kind: "pr" as const,
    repo: src.repo,
    prNumber: src.pr,
    // Omitted when the repo was disconnected but the PR source lingers → the
    // client falls back to rendering it top-level.
    parentId: branchByRepo.get(src.repo),
  }
}

/** The /v1/tags response body, from a WorkspaceSummary — shared by the tags route and
 *  the bootstrap arm so the sort (count desc, then tag) and the workspace-name default
 *  stay identical. */
export const summaryJson = (summary: WorkspaceSummary) => ({
  total: summary.total,
  favorites: summary.favorites,
  mine: summary.mine,
  mine_private: summary.minePrivate,
  tags: [...summary.tags].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
  workspace: summary.workspace ?? DEFAULT_WORKSPACE_NAME,
})

/** The /v1/collections response body from the store's overview + batched roles — the
 *  list route's exact chain (operator token = owner everywhere; creator = owner; else
 *  the batched map; null role rows drop out) followed by origin enrichment. */
export const collectionsJson = (
  cols: (CollectionRecord & { count: number })[],
  sources: { collection_id: string; repo: string; pr_number: number | null }[],
  roleMap: Record<string, Role>,
  meId: string | null,
  operator: boolean,
  /** Ids this caller starred. Rides the same read as the list so the sidebar's
   *  starred group costs no extra request. */
  starredIds: ReadonlySet<string> = new Set(),
  /** The caller's latest touch per collection, lately. Same read as the list — the
   *  Collections view orders on this and must not pay a second round trip for it. */
  workedIn: ReadonlyMap<string, string> = new Map(),
  previews: Record<string, CollectionPreview[]> = {},
  /** Live rows for the previews' authors — heals the denormalized name to the person's
   *  CURRENT one, same precedence as authorProfile: for an agent publish the stored
   *  name is the CLIENT ("Claude Code (derive)"), and the id is the human it acted for. */
  previewBylines: { id: string; name: string | null; username: string | null }[] = [],
) => {
  const { srcByCollection, branchByRepo } = sourceMaps(sources)
  const bylineById = new Map(previewBylines.map((u) => [u.id, u]))
  const healedName = (p: CollectionPreview) => {
    const live = p.author_id ? bylineById.get(p.author_id) : undefined
    return live?.name ?? live?.username ?? p.author_name
  }
  const roleFor = (col: CollectionRecord): Role | null =>
    operator ? "owner" : col.created_by === meId ? "owner" : (roleMap[col.id] ?? null)
  return (
    cols
      .map((col) => ({ col, role: roleFor(col) }))
      .filter(({ role }) => role !== null)
      // Pin the wire order: the Postgres overview read is a bare UNION ALL (heap order,
      // free to shift between requests), while the SQLite store lists newest-first. Sort
      // here so every store serves the same contract and no client inherits plan order.
      .sort(
        (a, b) =>
          new Date(b.col.created_at).getTime() - new Date(a.col.created_at).getTime() ||
          a.col.id.localeCompare(b.col.id),
      )
      .map(({ col, role }) =>
        enrich(
          {
            ...col,
            my_role: role,
            starred: starredIds.has(col.id),
            active: workedIn.has(col.id),
            my_last_activity: workedIn.get(col.id),
            // Everything the Collections digest renders per cover: the caption (title),
            // the window check (updated_at), and the recent-editor avatars (byline).
            // Only the internal id stays server-side.
            preview: (previews[col.id] ?? []).map((p) => ({
              short_id: p.short_id,
              title: p.title,
              current_version: p.current_version,
              has_preview: p.has_preview,
              updated_at: p.updated_at,
              author_name: healedName(p),
              author_login: p.author_login,
              author_avatar: p.author_avatar,
            })),
            last_activity: previews[col.id]?.[0]?.updated_at,
          },
          srcByCollection,
          branchByRepo,
        ),
      )
  )
}

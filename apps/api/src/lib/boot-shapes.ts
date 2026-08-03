import type { CollectionRecord, Role, WorkspaceSummary } from "@derive/core"
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
    my_role: z
      .enum(["viewer", "commenter", "editor", "owner"])
      .nullable()
      .optional()
      .describe("Caller's own role on the collection; drives the Share dialog. Null if none."),
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
  col: CollectionRecord & { count: number; my_role: Role | null },
  srcByCollection: Map<string, Src>,
  branchByRepo: Map<string, string>,
) => {
  const src = srcByCollection.get(col.id)
  if (!src) return { ...col, kind: "manual" as const }
  if (src.pr === null) return { ...col, kind: "repo" as const, repo: src.repo }
  return {
    ...col,
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
) => {
  const { srcByCollection, branchByRepo } = sourceMaps(sources)
  const roleFor = (col: CollectionRecord): Role | null =>
    operator ? "owner" : col.created_by === meId ? "owner" : (roleMap[col.id] ?? null)
  return cols
    .map((col) => ({ col, role: roleFor(col) }))
    .filter(({ role }) => role !== null)
    .map(({ col, role }) => enrich({ ...col, my_role: role }, srcByCollection, branchByRepo))
}

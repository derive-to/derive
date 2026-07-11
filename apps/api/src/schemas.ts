import type { Role } from "@derive/core"
import { z } from "@hono/zod-openapi"

/** Shared response schemas — the ones several routers return, so they live in one place
 *  and surface as a single reusable component in the OpenAPI spec (and one generated web
 *  type). A router-local schema stays in its route file; only genuinely-shared shapes
 *  belong here. */

/** The role vocabulary as a zod enum, shared by every router that takes or returns a
 *  role. `satisfies` ties the members to core's `Role` union, so renaming a tier there
 *  fails to compile here (adding one still needs a matching edit — keep them in step). */
export const roleEnum = z.enum([
  "viewer",
  "commenter",
  "editor",
  "owner",
] as const satisfies readonly Role[])

/** A collaborator on an artifact or collection — identified by public @handle, never
 *  email. Returned by `sharing`, `collections` (members), and later `workspace` members,
 *  so its schema is defined once here. `profession` is joined only by some payloads
 *  (e.g. workspace members); absent on artifact/collection member lists. */
export const ArtifactMember = z
  .object({
    user_id: z.string(),
    handle: z.string().nullable().describe("Public @handle; null when the user has none."),
    name: z.string().nullable().describe("Display name; null when unset."),
    profession: z
      .string()
      .nullable()
      .optional()
      .describe("Joined only on workspace-member payloads; absent on artifact/collection lists."),
    role: roleEnum.describe("Permission tier, ascending: viewer < commenter < editor < owner."),
  })
  .openapi("ArtifactMember")

/** One line of a unified diff: context, addition, or deletion. Returned in a proposal's
 *  diff and in an artifact version diff, so it's shared here. */
export const DiffOp = z
  .object({
    t: z
      .enum(["ctx", "add", "del"])
      .describe("Line op: ctx = unchanged context, add = added, del = removed."),
    line: z.string().describe("The line's text; the +/- marker lives in `t`, not here."),
  })
  .openapi("DiffOp")

/** A person or agent @mentioned in a comment — id + display name (the picker supplies
 *  ids, so there's no server-side name parsing). Nested in Comment.mentions. */
export const Mention = z
  .object({
    id: z.string().describe("Id of the mentioned person or agent."),
    name: z.string(),
  })
  .openapi("Mention")

/** Time-grouped view of an artifact's versions for display (newest-first). */
export const VersionSession = z
  .object({
    n: z.number().describe("Newest version number in this grouped session."),
    from_n: z.number().describe("Oldest version number in this grouped session."),
    count: z.number().describe("How many versions this session groups."),
    author: z.string(),
    name: z.string().nullable().describe("Session label; null when unnamed."),
    created_at: z.string().describe("Timestamp of the newest version in the group."),
  })
  .openapi("VersionSession")

/** A collection that grants access to an artifact, as the share dialog discloses it: a
 *  workspace-open collection reaches every workspace seat at their role; an invite-only
 *  one reaches its explicit members. The artifact's own access fields never see this
 *  grant (it folds into the explicit slot — see access-model.md), so the dialog must. */
export const CollectionGrant = z
  .object({
    id: z.string(),
    title: z.string(),
    workspace_access: z
      .enum(["none", "member"])
      .describe('"member" = every workspace seat opens the artifact at their role.'),
    my_role: z
      .enum(["viewer", "commenter", "editor", "owner"])
      .nullable()
      .describe("Caller's role on the COLLECTION (owner ⇒ can manage its sharing); null if none."),
    member_count: z
      .number()
      .describe("Explicit collection-member rows (the creator always holds one)."),
    created_by: z.string().describe("Creator's user id — permanently owner of the collection."),
    owner_name: z
      .string()
      .nullable()
      .describe('Creator\'s display name for attribution ("Managed by …"); null when unknown.'),
  })
  .openapi("CollectionGrant")

/** The artifact view-model — the largest, most-composed shape in the client. Built by
 *  core's toJson() plus per-request enrichment (roles, counts, tags, threads). Returned
 *  by the artifacts router AND session's /users/:handle/artifacts, so it's shared here.
 *  Fields match the web Artifact interface exactly; the handler may return extra fields
 *  (org_id, raw bytes) that are omitted here — extras are tolerated. */
export const Artifact = z
  .object({
    short_id: z.string().describe("Stable public id — the /a/<short_id> URL slug."),
    url: z.string().describe("Canonical public URL of the artifact."),
    title: z.string().nullable().describe("Display title; null when untitled or taken down."),
    kind: z
      .enum(["file", "bundle"])
      .describe("file = single file; bundle = multi-file archive (skill, site, or docs folder)."),
    current_content_type: z
      .string()
      .nullable()
      .optional()
      .describe("MIME type of the current version's content."),
    locked: z
      .boolean()
      .optional()
      .describe("When true, direct publishes are blocked — changes go through review."),
    workspace_access: z
      .enum(["none", "member"])
      .optional()
      .describe("v2 access: member = workspace seats reach it at their role; none = they don't."),
    link_role: z
      .enum(["none", "viewer", "commenter", "editor"])
      .optional()
      .describe("v2 access: what merely holding the world link confers (none = no link)."),
    listed: z
      .enum(["none", "workspace", "public"])
      .optional()
      .describe("v2 access: where it surfaces for discovery — nowhere, the workspace, or public."),
    password_protected: z
      .boolean()
      .optional()
      .describe("true when the world link is password-locked (the password is never returned)."),
    org_id: z
      .string()
      .optional()
      .describe("The artifact's workspace id; drives move-to-workspace."),
    raw_token: z
      .string()
      .optional()
      .describe("Signed, short-lived token for fetching raw content; detail responses only."),
    spa: z
      .boolean()
      .optional()
      .describe("true when the bundle is a single-page app (all paths route to the entry)."),
    current_version: z
      .number()
      .describe("Latest version number; 0 before any content is published."),
    versions: z.array(
      z.object({
        n: z.number(),
        content_type: z.string().optional().describe("MIME type of this version's content."),
        author: z.string().describe("Display byline; heals to the author's current name."),
        author_login: z
          .string()
          .nullable()
          .optional()
          .describe("Committer's GitHub login; null when not a GitHub commit."),
        author_avatar: z.string().nullable().optional(),
        author_gh_id: z
          .string()
          .nullable()
          .optional()
          .describe("Committer's GitHub user id; null when not a GitHub commit."),
        handle: z
          .string()
          .nullable()
          .optional()
          .describe("Committer's Derive @handle; null unless they signed in with GitHub."),
        message: z.string().nullable().describe("Version (commit) message; null when none given."),
        name: z.string().nullable().describe("Optional version label; null when unnamed."),
        created_at: z.string(),
      }),
    ),
    sessions: z
      .array(VersionSession)
      .optional()
      .describe("Versions grouped into time-clustered sessions for the UI (newest-first)."),
    views: z.number().optional().describe("Total views; present only when analytics is enabled."),
    my_role: z
      .enum(["viewer", "commenter", "editor", "owner"])
      .nullable()
      .optional()
      .describe("The caller's effective permission tier; null when they have none."),
    tags: z.array(z.string()).optional(),
    favorite: z.boolean().optional().describe("true when the caller has favorited this."),
    has_preview: z
      .boolean()
      .optional()
      .describe("true when the current version has a ready screenshot preview."),
    open_proposals: z.number().optional().describe("Count of open (pending-review) proposals."),
    proposals_total: z
      .number()
      .optional()
      .describe("Count of all proposals except withdrawn ones."),
    open_threads: z.number().optional().describe("Count of open (unresolved) comment threads."),
    mentions_me: z
      .boolean()
      .optional()
      .describe("true when an open thread @mentions the calling user."),
    i_participated: z
      .boolean()
      .optional()
      .describe("true when the caller authored or commented in a thread here."),
    collections: z
      .array(z.string())
      .optional()
      .describe("Ids of the collections that include this artifact."),
    collection_access: z
      .array(CollectionGrant)
      .optional()
      .describe(
        "Collections whose sharing ADDS reach to this artifact — the share dialog's " +
          "disclosure rows, renderable verbatim (the caller's own solo invite-only " +
          "collection is already excluded). Detail responses only; scoped to collections " +
          "the caller can see, except the artifact's managers (explicit or seat standing " +
          "— never mere link-holders), who see every granting collection.",
      ),
    removed: z
      .boolean()
      .optional()
      .describe("true when the artifact has been taken down (tombstone)."),
    managed: z
      .boolean()
      .optional()
      .describe("true when mirrored from a GitHub sync — read-only in Derive."),
    bundle: z
      .object({
        isSkill: z.boolean().describe("true when the bundle is a skill (entry SKILL.md)."),
        name: z.string().nullable().describe("Skill/bundle name; null when not declared."),
        description: z
          .string()
          .nullable()
          .describe("Skill/bundle description; null when not declared."),
        entry: z.string().describe("Path of the entry document rendered first."),
        files: z
          .array(z.object({ path: z.string(), type: z.string() }))
          .describe("The bundle's file tree (path + MIME type) for navigation."),
      })
      .optional()
      .describe(
        "Present for a markdown bundle (skill or docs folder): entry, file tree, identity.",
      ),
    source_path: z
      .string()
      .nullable()
      .optional()
      .describe("Source path (e.g. the repo path of a synced artifact); null when none."),
    created_at: z.string().optional(),
    updated_at: z
      .string()
      .nullable()
      .optional()
      .describe("Last-update timestamp; null when never updated since creation."),
    author_name: z
      .string()
      .nullable()
      .optional()
      .describe("Raw current-author name; the resolved `author` object is preferred."),
    author_login: z
      .string()
      .nullable()
      .optional()
      .describe("Raw current-author GitHub login; null when not from GitHub."),
    author_avatar: z
      .string()
      .nullable()
      .optional()
      .describe("Raw current-author avatar URL; null when none."),
    author_gh_id: z
      .string()
      .nullable()
      .optional()
      .describe("Raw current-author GitHub id; null when not from GitHub."),
    author: z
      .object({
        name: z.string().nullable(),
        login: z.string().nullable().describe("GitHub login; null if never signed in with GitHub."),
        avatar: z.string().nullable(),
        handle: z.string().nullable().describe("Derive @handle; null when the author has none."),
      })
      .nullable()
      .optional()
      .describe("Resolved current-author profile; preferred over the raw author_* fields."),
  })
  .openapi("Artifact")

/** A Brandprint: a pointer to a conventions collection an agent reads as house style, plus
 *  the generated brand-profile artifact's short_id. Not `.openapi()`'d — it rides inline
 *  inside OrgSettings and the profile body, not as its own component. See
 *  packages/core/src/ports.ts Brandprint. */
export const BrandprintSchema = z.object({
  collectionId: z.string().trim().max(64).nullish(),
  profileId: z.string().trim().max(64).nullish(),
})

/** The personal layer is collection-only — the brand profile is a team property, so the
 *  profile route's request AND response omit `profileId` (a sent one strips, same as any
 *  unknown key, and the generated types can't advertise a field the server never returns). */
export const PersonalBrandprintSchema = BrandprintSchema.omit({ profileId: true })

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

/** Capability tiers are durable intent for an execution harness, never a concrete model
 * selection. A diagram can set a default and a node can narrow it. */
const linkedBundleTierEnum = z.enum(["utility", "fast", "balanced", "expert", "frontier"])

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
    agent_name: z
      .string()
      .nullable()
      .describe(
        "The agent that produced the session on the author's behalf; null for the person's own edits.",
      ),
    name: z.string().nullable().describe("Session label; null when unnamed."),
    created_at: z.string().describe("Timestamp of the newest version in the group."),
  })
  .openapi("VersionSession")

/** The one workflow gate rendered by both the CLI and the shared artifact page.
 * It is descriptive only: execution_started is always false because opening or
 * previewing an artifact never starts a context session. */
export const WorkflowPreview = z
  .object({
    status: z.enum(["ready", "needs-changes"]),
    execution_started: z.literal(false),
    purpose: z.string().nullable(),
    errors: z.array(z.string()),
    warnings: z.array(z.string()),
    diagrams: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        will_do: z.array(z.string()),
        may_do: z.array(z.string()),
        will_pause: z.array(z.string()),
        can_repeat: z.array(z.string()),
        side_effects: z.array(z.string()),
        node_details: z.array(
          z.object({
            node_id: z.string(),
            instruction: z.string().nullable(),
            result: z.string().nullable(),
          }),
        ),
        context_sessions: z.array(
          z.object({
            node_id: z.string(),
            label: z.string(),
            context_ref: z.string(),
            result: z.string(),
            starts_when: z.string(),
          }),
        ),
        scenarios: z.array(
          z.object({
            kind: z.enum(["expected", "failure", "human"]),
            outcome: z.string(),
          }),
        ),
      }),
    ),
    cannot_do: z.array(z.string()),
  })
  .openapi("WorkflowPreview")

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
/** A comment, as every comment route serves it (lib/comments.ts commentJson). */
export const Comment = z
  .object({
    id: z.string(),
    artifact_id: z.string().describe("The artifact the comment is on."),
    thread_id: z
      .string()
      .describe("The thread this comment belongs to; equals id for the thread's root comment."),
    base_version: z.number().describe("Artifact version this comment was anchored against."),
    path: z
      .string()
      .nullable()
      .describe("File within a bundle the comment targets; null if not file-scoped."),
    anchor: z
      .string()
      .nullable()
      .describe(
        "Serialized text-quote or element anchor locating the comment; null if unanchored.",
      ),
    body_md: z.string().describe("Comment body in Markdown; blanked when the comment is deleted."),
    author: z.string().describe('Author\'s display name; "anonymous" for an anonymous poster.'),
    author_id: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Stable id of the author — a user id, an agent id, or "derive" for the built-in chat agent; null for anonymous or legacy rows.',
      ),
    author_kind: z
      .enum(["user", "agent", "anonymous"])
      .describe("What kind of principal wrote it, from the recorded id."),
    resolution: z
      .object({
        at: z.string(),
        by: z.string().nullable().describe("The resolver's display name at the time."),
        by_id: z.string().nullable(),
        by_kind: z.enum(["user", "agent"]).nullable(),
        version: z
          .number()
          .nullable()
          .describe("The version whose publish resolved the thread; null for a hand resolve."),
      })
      .nullable()
      .optional()
      .describe("On a resolved thread's root: who settled it, when, and by which version."),
    state: z
      .enum(["open", "resolved", "outdated"])
      .describe("Thread state: open, resolved, or outdated (the quoted text changed)."),
    created_at: z.string(),
    anchored: z
      .boolean()
      .optional()
      .describe("Whether the anchor still resolves against the current version (list only)."),
    reactions: z
      .record(z.string(), z.array(z.string()))
      .optional()
      .describe("Emoji → list of reactor display names."),
    edited: z.boolean().optional().describe("True if the body was edited after posting."),
    edited_at: z
      .string()
      .nullable()
      .optional()
      .describe("When the comment was last edited; null if never."),
    deleted: z
      .boolean()
      .optional()
      .describe("True if soft-deleted; the row stays but the body is blanked."),
    mentions: z
      .array(Mention)
      .optional()
      .describe("Users or agents @mentioned in the comment body."),
  })
  .openapi("Comment")

/** A review round, as the review routes and the workspace activity serve it
 *  (lib/review-json.ts roundJson). */
export const ReviewRound = z
  .object({
    id: z.string(),
    artifact_id: z.string(),
    version: z.number().describe("The artifact version this round is reviewing."),
    requested_by: z
      .string()
      .describe("Who asked for the review (usually the agent that published)."),
    requested_by_name: z
      .string()
      .nullable()
      .describe(
        "The requester's name when the round opened (a row from before the name was kept is named from the directory, while the agent exists).",
      ),
    requested_by_kind: z
      .enum(["user", "agent"])
      .describe("What kind of principal asked, from the recorded id."),
    requested_for: z.string().describe("The person asked to answer this round."),
    state: z
      .enum(["pending", "sent_back"])
      .describe(
        "Round state: pending, or sent_back (the answers came back — a note saying go IS the go-signal).",
      ),
    note: z.string().nullable().describe("Free-text note attached to the round; null if none."),
    resolved_by_name: z
      .string()
      .nullable()
      .describe(
        "The human who settled the round; null while pending, or when the store has no name for the resolver.",
      ),
    created_at: z.string(),
    resolved_at: z.string().nullable().describe("When it was sent back; null while pending."),
  })
  .openapi("ReviewRound")

/** One version in the workspace activity feed: the artifact rail's version shape, cut to
 *  what a line needs, plus the artifact it belongs to. */
export const ActivityVersion = z
  .object({
    artifact_id: z.string(),
    n: z.number(),
    author: z.string().describe("The person's byline, healed to their live name."),
    handle: z.string().nullable(),
    agent: z
      .object({ id: z.string(), name: z.string() })
      .nullable()
      .describe(
        "The agent that produced this version on the author's behalf; null for the person's own.",
      ),
    message: z.string().nullable(),
    name: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("ActivityVersion")

/** The workspace's recent activity, for the home: everything the stream is built from,
 *  over the artifacts the viewer can see. The client folds it (pages/artifact/lib/activity.ts). */
export const WorkspaceActivity = z
  .object({
    since: z.string().describe("The window's start (ISO)."),
    artifacts: z
      .array(z.object({ id: z.string(), short_id: z.string(), title: z.string() }))
      .describe("The artifacts the rows below belong to — only those the viewer can read."),
    versions: z.array(ActivityVersion),
    comments: z.array(Comment),
    rounds: z
      .array(ReviewRound)
      .describe("Pending rounds (any age) and rounds opened or settled in the window."),
  })
  .openapi("WorkspaceActivity")

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
    badge: z
      .boolean()
      .optional()
      .describe(
        "Show the Made-with-Derive mark on this artifact's public surfaces (false = white-label workspace).",
      ),
    open_comment_count: z
      .number()
      .optional()
      .describe(
        "Open-thread count for the sign-in-to-comment pill; present only for anonymous callers on a link that grants commenting.",
      ),
    public_history: z
      .boolean()
      .optional()
      .describe(
        "Owner opt-in: readers without artifact standing can browse version history. When false, their detail responses carry only the current version.",
      ),
    is_workspace_member: z
      .boolean()
      .optional()
      .describe(
        "True when the signed-in caller has an active seat in the artifact's workspace. False for link-only readers and members acting in another workspace.",
      ),
    org_id: z
      .string()
      .optional()
      .describe("The artifact's workspace id; drives move-to-workspace."),
    raw_token: z
      .string()
      .optional()
      .describe("Signed, short-lived token for fetching raw content; detail responses only."),
    raw_token_expires_at: z
      .string()
      .optional()
      .describe("Expiry of raw_token as an ISO timestamp; detail responses only."),
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
        agent: z
          .object({ id: z.string(), name: z.string() })
          .nullable()
          .optional()
          .describe(
            "The agent that produced this version on the author's behalf; null for the person's own publish.",
          ),
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
    archived: z
      .boolean()
      .optional()
      .describe("true when the artifact is on the reversible archive shelf."),
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
    linked_bundle: z
      .object({
        schema: z.literal("derive.linked-bundle/v1"),
        purpose: z.string(),
        members: z.array(
          z.object({
            id: z.string(),
            ref: z.string(),
            label: z.string(),
            role: z.string().optional(),
            note: z.string().optional(),
            available: z.boolean(),
            url: z.string().optional(),
            title: z.string().nullable().optional(),
            content_type: z.string().nullable().optional(),
            current_version: z.number().int().positive().optional(),
            updated_at: z.string().nullable().optional(),
            open_comment_count: z.number().int().nonnegative().optional(),
          }),
        ),
        diagrams: z
          .array(
            z.object({
              id: z.string(),
              title: z.string(),
              type: z.enum(["loop", "graph"]),
              tier: linkedBundleTierEnum
                .optional()
                .describe("Default capability tier for nodes without their own tier."),
              nodes: z.array(
                z.object({
                  id: z.string(),
                  label: z.string(),
                  member: z.string().optional(),
                  role: z.string().optional().describe("The responsibility this node owns."),
                  tier: linkedBundleTierEnum
                    .optional()
                    .describe("Node capability tier; overrides the diagram default."),
                  state: z.enum(["pending", "active", "waiting", "blocked", "done"]).optional(),
                  basis_version: z.number().int().positive().optional(),
                  note: z.string().optional(),
                  confidence: z
                    .object({
                      level: z.enum(["low", "medium", "high"]),
                      basis: z.string(),
                    })
                    .optional()
                    .describe("Current confidence and the evidence or judgment supporting it."),
                  help: z
                    .object({
                      needed: z.boolean(),
                      question: z.string().optional(),
                      can_continue: z.string().optional(),
                    })
                    .optional()
                    .describe(
                      "Whether help is needed, the concise question, and work that can continue.",
                    ),
                }),
              ),
              edges: z.array(
                z.object({ from: z.string(), to: z.string(), label: z.string().optional() }),
              ),
              goal: z.string().optional(),
              evaluate: z.string().optional(),
              stop: z.string().optional(),
            }),
          )
          .optional(),
      })
      .optional()
      .describe(
        "Present for an HTML artifact carrying a valid bundle-manifest fact. Members are resolved through the caller's normal read permissions; unavailable members expose no additional metadata.",
      ),
    workflow_preview: WorkflowPreview.optional().describe(
      "Present when the current linked bundle also carries workflow-definition. This is the validated, non-executing shared Preview.",
    ),
    derived_from: z
      .object({
        short_id: z.string(),
        title: z.string().nullable(),
      })
      .nullable()
      .optional()
      .describe(
        'The artifact this one was copied from ("use as template"). ' +
          "Detail responses only; null when the source no longer resolves, absent when not derived.",
      ),
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

/** The brand profile is a team property, so the profile route's request AND response
 *  omit `profileId` (a sent one strips, same as any unknown key, and the generated
 *  types can't advertise a field the server never returns). */
export const PersonalBrandprintSchema = BrandprintSchema.omit({ profileId: true }).extend({
  useWorkspaceBrandprint: z
    .boolean()
    .optional()
    .describe(
      "False turns the workspace Brandprint off for this user; their personal collection still applies. Absent or true: the workspace layer applies. Personal scope only.",
    ),
})

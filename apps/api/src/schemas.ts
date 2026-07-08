import { z } from "@hono/zod-openapi"

/** Shared response schemas — the ones several routers return, so they live in one place
 *  and surface as a single reusable component in the OpenAPI spec (and one generated web
 *  type). A router-local schema stays in its route file; only genuinely-shared shapes
 *  belong here. */

/** A collaborator on an artifact or collection — identified by public @handle, never
 *  email. Returned by `sharing`, `collections` (members), and later `workspace` members,
 *  so its schema is defined once here. `profession` is joined only by some payloads
 *  (e.g. workspace members); absent on artifact/collection member lists. */
export const ArtifactMember = z
  .object({
    user_id: z.string(),
    handle: z.string().nullable(),
    name: z.string().nullable(),
    profession: z.string().nullable().optional(),
    role: z.enum(["viewer", "commenter", "editor", "owner"]),
  })
  .openapi("ArtifactMember")

/** One line of a unified diff: context, addition, or deletion. Returned in a proposal's
 *  diff and in an artifact version diff, so it's shared here. */
export const DiffOp = z
  .object({ t: z.enum(["ctx", "add", "del"]), line: z.string() })
  .openapi("DiffOp")

/** A person or agent @mentioned in a comment — id + display name (the picker supplies
 *  ids, so there's no server-side name parsing). Nested in Comment.mentions. */
export const Mention = z.object({ id: z.string(), name: z.string() }).openapi("Mention")

/** Time-grouped view of an artifact's versions for display (newest-first). */
export const VersionSession = z
  .object({
    n: z.number(),
    from_n: z.number(),
    count: z.number(),
    author: z.string(),
    name: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("VersionSession")

/** The artifact view-model — the largest, most-composed shape in the client. Built by
 *  core's toJson() plus per-request enrichment (roles, counts, tags, threads). Returned
 *  by the artifacts router AND session's /users/:handle/artifacts, so it's shared here.
 *  Fields match the web Artifact interface exactly; the handler may return extra fields
 *  (org_id, raw bytes) that are omitted here — extras are tolerated. */
export const Artifact = z
  .object({
    short_id: z.string(),
    url: z.string(),
    title: z.string().nullable(),
    kind: z.enum(["file", "bundle"]),
    current_content_type: z.string().nullable().optional(),
    locked: z.boolean().optional(),
    visibility: z.string(),
    /** Single-page app bundle flag (present on the tombstone branch of the detail view). */
    spa: z.boolean().optional(),
    general_role: z.enum(["viewer", "commenter"]).optional(),
    current_version: z.number(),
    versions: z.array(
      z.object({
        n: z.number(),
        content_type: z.string().optional(),
        author: z.string(),
        author_login: z.string().nullable().optional(),
        author_avatar: z.string().nullable().optional(),
        author_gh_id: z.string().nullable().optional(),
        handle: z.string().nullable().optional(),
        message: z.string().nullable(),
        name: z.string().nullable(),
        created_at: z.string(),
      }),
    ),
    sessions: z.array(VersionSession).optional(),
    views: z.number().optional(),
    my_role: z.enum(["viewer", "commenter", "editor", "owner"]).nullable().optional(),
    tags: z.array(z.string()).optional(),
    favorite: z.boolean().optional(),
    open_proposals: z.number().optional(),
    proposals_total: z.number().optional(),
    open_threads: z.number().optional(),
    mentions_me: z.boolean().optional(),
    i_participated: z.boolean().optional(),
    collections: z.array(z.string()).optional(),
    removed: z.boolean().optional(),
    managed: z.boolean().optional(),
    bundle: z
      .object({
        isSkill: z.boolean(),
        name: z.string().nullable(),
        description: z.string().nullable(),
        entry: z.string(),
        files: z.array(z.object({ path: z.string(), type: z.string() })),
      })
      .optional(),
    source_path: z.string().nullable().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().nullable().optional(),
    author_name: z.string().nullable().optional(),
    author_login: z.string().nullable().optional(),
    author_avatar: z.string().nullable().optional(),
    author_gh_id: z.string().nullable().optional(),
    author: z
      .object({
        name: z.string().nullable(),
        login: z.string().nullable(),
        avatar: z.string().nullable(),
        handle: z.string().nullable(),
      })
      .nullable()
      .optional(),
  })
  .openapi("Artifact")

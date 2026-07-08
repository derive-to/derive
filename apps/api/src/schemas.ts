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

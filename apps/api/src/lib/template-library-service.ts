import {
  type ArtifactRecord,
  newId,
  type TemplateLibraryEntryRecord,
  type TemplateLibraryRecord,
} from "@derive/core"
import type { Context } from "hono"
import type { AppContext } from "../context"
import { fail } from "./http"
import { likelySecrets } from "./secret-scan"
import { canReadTemplateLibrary } from "./template-library-access"
import { templateLibraryEntryJson } from "./template-library-entry"

export const createTemplateLibraryService = (ctx: AppContext) => {
  const {
    activeWorkspace,
    authorizeStanding,
    isToken,
    managementPrincipal,
    membershipOf,
    meta,
    privateOwnerId,
    sourceText,
    workspaceCan,
  } = ctx

  // A read-scoped OAuth agent may use its grantor's private library. Only a
  // manage-scoped principal may mutate one, so keep these identities separate.
  const readerFor = async (c: Context): Promise<string | null> =>
    (await privateOwnerId(c)) ?? (isToken(c) ? "token" : null)
  const managerFor = async (c: Context): Promise<string | null> =>
    (await managementPrincipal(c)) ?? (isToken(c) ? "token" : null)

  const canRead = async (c: Context, library: TemplateLibraryRecord): Promise<boolean> => {
    const workspaceReachable =
      (await activeWorkspace(c)) === library.org_id && (await workspaceCan(c, "read"))
    return canReadTemplateLibrary(library, {
      ownerId: await readerFor(c),
      workspaceReachable,
      isMember: workspaceReachable,
      isOperator: isToken(c),
    })
  }
  const canManage = async (c: Context, library: TemplateLibraryRecord): Promise<boolean> => {
    const owner = await managerFor(c)
    const active = await activeWorkspace(c)
    if (active !== library.org_id || !(await workspaceCan(c, "publish"))) return false
    if (isToken(c) || library.created_by === owner) return true
    return !!owner && (await membershipOf(c, library.org_id, owner))?.role === "owner"
  }

  /** Copying a pinned source into a wider library is a share operation, not merely a read. */
  const canDistribute = async (
    c: Context,
    source: ArtifactRecord,
    scope: "private" | "workspace" | "public",
    targetOrg: string,
  ): Promise<boolean> => {
    if (scope === "private" || isToken(c)) return true
    if (
      scope === "workspace" &&
      source.org_id === targetOrg &&
      source.workspace_access === "member"
    )
      return true
    // A world link grants consumption, never redistribution. Otherwise anyone who
    // happens to receive an unlisted viewer link could turn it into a globally
    // discoverable public starter. Public publication requires standing share
    // authority (membership or an explicit artifact grant), exactly like widening
    // the artifact's own reach.
    return authorizeStanding(c, "share", source)
  }

  const scopeCanDistributeEntries = async (
    c: Context,
    library: TemplateLibraryRecord,
    scope: "private" | "workspace" | "public",
  ): Promise<boolean> => {
    if (scope === "private") return true
    const entries = await meta.listTemplateLibraryEntries(library.id)
    const sources = new Map(
      (await meta.getArtifactsByIds(entries.map((entry) => entry.source_artifact_id))).map(
        (source) => [source.id, source],
      ),
    )
    const allowed = await Promise.all(
      entries.map(async (entry) => {
        const source = sources.get(entry.source_artifact_id)
        if (!source || source.removed_at) return false
        const starter =
          scope === "public"
            ? await sourceText({
                blob_key: entry.source_blob_key,
                content_type: entry.source_content_type,
              })
            : ""
        return !(
          (scope === "public" && (starter === null || likelySecrets(starter).length > 0)) ||
          !(await canDistribute(c, source, scope, library.org_id))
        )
      }),
    )
    return allowed.every(Boolean)
  }

  const libraryJson = async (
    c: Context,
    library: TemplateLibraryRecord,
    opts?: {
      entries?: TemplateLibraryEntryRecord[]
      entryCount?: number
      publisher?: { name: string | null; username: string | null; image: string | null }
    },
  ) => {
    const entries = opts?.entries
    const entryCount =
      opts?.entryCount ??
      entries?.length ??
      (await meta.countTemplateLibraryEntries([library.id]))[library.id] ??
      0
    const publisher = opts?.publisher ??
      (await meta.getUsers([library.created_by]))[0] ?? { name: null, username: null, image: null }
    return {
      id: library.id,
      title: library.title,
      description: library.description,
      scope: library.scope,
      created_at: library.created_at,
      updated_at: library.updated_at,
      entry_count: entryCount,
      ...(entries ? { entries: entries.map(templateLibraryEntryJson) } : {}),
      publisher: {
        name: publisher.name ?? publisher.username ?? null,
        username: publisher.username ?? null,
        image: publisher.image ?? null,
      },
      can_manage: await canManage(c, library),
    }
  }

  const requireLibrary = async (c: Context): Promise<TemplateLibraryRecord | Response> => {
    const id = c.req.param("id")
    const library = id ? await meta.getTemplateLibrary(id) : null
    if (!library || !(await canRead(c, library))) return fail(c, 404, "not found")
    return library
  }
  const requireManagedLibrary = async (c: Context): Promise<TemplateLibraryRecord | Response> => {
    const library = await requireLibrary(c)
    if (library instanceof Response) return library
    if (!(await canManage(c, library))) return fail(c, 403, "forbidden")
    return library
  }

  const beginManagedMutation = async (
    c: Context,
    library: TemplateLibraryRecord,
  ): Promise<{ library: TemplateLibraryRecord; token: string } | Response> => {
    const token = newId("tlm")
    const staleBefore = new Date(Date.now() - 2 * 60_000).toISOString()
    if (!(await meta.acquireTemplateLibraryMutation(library.id, token, staleBefore)))
      return fail(c, 409, "template library is changing; retry")

    // Re-read scope and authorization only after acquiring the lease. This
    // closes the validate-private / publish-public race between concurrent calls.
    const fresh = await meta.getTemplateLibrary(library.id)
    if (!fresh || !(await canManage(c, fresh))) {
      await meta.releaseTemplateLibraryMutation(library.id, token)
      return fail(c, fresh ? 403 : 404, fresh ? "forbidden" : "not found")
    }
    return { library: fresh, token }
  }

  const renewManagedMutation = async (
    c: Context,
    mutation: { library: TemplateLibraryRecord; token: string },
  ): Promise<Response | undefined> => {
    if (await meta.renewTemplateLibraryMutation(mutation.library.id, mutation.token))
      return undefined
    return fail(c, 409, "template library changed while this request was validating; retry")
  }

  return {
    readerFor,
    managerFor,
    canDistribute,
    scopeCanDistributeEntries,
    libraryJson,
    requireLibrary,
    requireManagedLibrary,
    beginManagedMutation,
    renewManagedMutation,
  }
}

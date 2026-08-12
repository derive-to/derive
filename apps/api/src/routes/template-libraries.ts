import {
  type ArtifactRecord,
  newId,
  parseRef,
  type TemplateLibraryEntryRecord,
  type TemplateLibraryRecord,
} from "@derive/core"
import {
  BUILT_INS_LIBRARY_ID,
  listTemplates,
  TEMPLATE_CATALOG_VERSION,
  unsafeHtmlTemplateBindings,
} from "@derive-to/templates"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { bail, fail, readJson } from "../lib/http"
import { likelySecrets } from "../lib/secret-scan"
import { canReadTemplateLibrary } from "../lib/template-library-access"
import { templateLibraryEntryJson } from "../lib/template-library-entry"

/**
 * Reusable template libraries.
 *
 * A library is an explicit distribution boundary. Adding an artifact copies the
 * selected version's starter bytes into an entry reference; use never re-reads
 * the source artifact. This lets a public library stay reproducible even when
 * its source is revised or deleted, and makes the publication decision visible
 * in one place instead of silently broadening artifact access.
 */
export const templateLibraryRoutes = (ctx: AppContext) => {
  const {
    activeWorkspace,
    authorize,
    authorizeStanding,
    isToken,
    limited,
    managementPrincipal,
    membershipOf,
    meta,
    privateOwnerId,
    publishLimiter,
    sourceText,
    workspaceCan,
  } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  const Scope = z.enum(["private", "workspace", "public"])
  const EntryKind = z.enum(["artifact", "context"])
  const EntryFormat = z.enum(["md", "html"])
  const ListQuery = z.object({
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  const Input = z.object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(240),
    required: z.boolean().optional(),
  })
  const BuiltInTemplate = z
    .object({
      id: z.string(),
      kind: EntryKind,
      category: z.enum(["Deck", "Doc", "Report", "Site", "Agent"]),
      format: EntryFormat,
      title: z.string(),
      defaultTitle: z.string(),
      description: z.string(),
      outcome: z.string(),
      sections: z.array(z.string()),
      inputs: z.array(Input),
      tags: z.array(z.string()),
      featured: z.boolean().optional(),
      starterPrompts: z.array(z.string()).optional(),
      libraryId: z.literal(BUILT_INS_LIBRARY_ID),
      catalogVersion: z.literal(TEMPLATE_CATALOG_VERSION),
    })
    .openapi("BuiltInTemplate")

  const Entry = z
    .object({
      id: z.string(),
      library_id: z.string(),
      source_version: z.number().describe("Pinned source version captured on publication."),
      kind: EntryKind,
      category: z.string(),
      format: EntryFormat,
      title: z.string(),
      description: z.string(),
      outcome: z.string(),
      sections: z.array(z.string()),
      inputs: z.array(Input),
      tags: z.array(z.string()),
      created_at: z.string(),
    })
    .openapi("TemplateLibraryEntry")

  const Publisher = z.object({
    name: z.string().nullable(),
    username: z.string().nullable(),
    image: z.string().nullable(),
  })

  const Library = z
    .object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      scope: Scope.describe(
        "private = owner only; workspace = workspace members; public = anyone with the library URL or catalog.",
      ),
      created_at: z.string(),
      updated_at: z.string().nullable(),
      entry_count: z.number(),
      entries: z.array(Entry).optional(),
      publisher: Publisher,
      can_manage: z.boolean().optional(),
    })
    .openapi("TemplateLibrary")

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

  const parseLibraryCursor = (
    cursor?: string,
  ): { createdAt: string; id: string } | undefined | null => {
    if (!cursor) return undefined
    const split = cursor.lastIndexOf("~")
    if (split < 1) return null
    const createdAt = cursor.slice(0, split)
    const id = cursor.slice(split + 1)
    if (!id || Number.isNaN(Date.parse(createdAt))) return null
    return { createdAt, id }
  }
  const libraryCursor = (library: TemplateLibraryRecord): string =>
    `${library.created_at}~${library.id}`

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/templates",
      tags: ["Templates"],
      summary: "List the built-in template catalog.",
      responses: {
        200: {
          description: "Portable built-in template metadata; starter source remains agent-only.",
          content: {
            "application/json": { schema: z.object({ templates: z.array(BuiltInTemplate) }) },
          },
        },
      },
    }),
    (c) =>
      c.json({
        templates: listTemplates().map((template) => {
          const { sections, inputs, tags, starterPrompts, ...metadata } = template
          return {
            ...metadata,
            sections: [...sections],
            inputs: inputs.map((input) => ({ ...input })),
            tags: [...tags],
            ...(starterPrompts ? { starterPrompts: [...starterPrompts] } : {}),
          }
        }),
      }),
  )

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/template-libraries",
      tags: ["Templates"],
      summary: "List public libraries plus libraries accessible in the active workspace.",
      request: { query: ListQuery },
      responses: {
        200: {
          description:
            "Libraries the caller can discover. Public libraries are available anonymously.",
          content: {
            "application/json": {
              schema: z.object({
                libraries: z.array(Library),
                truncated: z.boolean(),
                next_cursor: z.string().nullable(),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const query = c.req.valid("query")
      const before = parseLibraryCursor(query.cursor)
      if (before === null) return bail(fail(c, 422, "invalid template-library cursor"))
      const limit = query.limit ?? 100
      const owner = await readerFor(c)
      const orgId = await activeWorkspace(c)
      const canReadWorkspace = await workspaceCan(c, "read")
      const [publicLibraries, workspaceLibraries, personalLibraries] = await Promise.all([
        meta.listTemplateLibraries({ scope: "public", before, limit: limit + 1 }),
        canReadWorkspace
          ? meta.listTemplateLibraries({
              orgId,
              scope: "workspace",
              before,
              limit: limit + 1,
            })
          : [],
        owner
          ? meta.listTemplateLibraries({
              orgId,
              scope: "private",
              createdBy: owner,
              before,
              limit: limit + 1,
            })
          : [],
      ])
      const seen = new Set<string>()
      const allLibraries = [...personalLibraries, ...workspaceLibraries, ...publicLibraries]
        .filter((library) => {
          if (seen.has(library.id)) return false
          seen.add(library.id)
          return true
        })
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
      const libraries = allLibraries.slice(0, limit)
      const entryCounts = await meta.countTemplateLibraryEntries(
        libraries.map((library) => library.id),
      )
      const publishers = new Map(
        (await meta.getUsers(libraries.map((library) => library.created_by))).map((user) => [
          user.id,
          user,
        ]),
      )
      return c.json({
        libraries: await Promise.all(
          libraries.map((library) =>
            libraryJson(c, library, {
              entryCount: entryCounts[library.id] ?? 0,
              publisher: publishers.get(library.created_by),
            }),
          ),
        ),
        truncated: allLibraries.length > libraries.length,
        next_cursor:
          allLibraries.length > libraries.length && libraries.length
            ? libraryCursor(libraries[libraries.length - 1] as TemplateLibraryRecord)
            : null,
      })
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/template-libraries",
      tags: ["Templates"],
      summary: "Create a template library in the active workspace.",
      responses: {
        201: {
          description: "The newly created empty library.",
          content: { "application/json": { schema: Library } },
        },
      },
    }),
    async (c) => {
      if (!(await workspaceCan(c, "publish"))) return bail(fail(c, 403, "forbidden"))
      const rateLimited = await limited(c, publishLimiter)
      if (rateLimited) return bail(rateLimited)
      const owner = await managerFor(c)
      if (!owner) return bail(fail(c, 401, "unauthenticated"))
      const orgId = await activeWorkspace(c)
      if ((await meta.listTemplateLibraries({ orgId, createdBy: owner, limit: 100 })).length >= 100)
        return bail(fail(c, 409, "template library limit reached for this workspace"))
      const body = await readJson(
        c,
        z.object({
          title: z.string().trim().min(1).max(120),
          description: z.string().trim().max(500).optional(),
          scope: Scope.optional(),
        }),
      )
      if (body instanceof Response) return bail(body)
      const library = await meta.createTemplateLibrary({
        id: newId("tlb"),
        org_id: orgId,
        title: body.title,
        description: body.description ?? "",
        scope: body.scope ?? "private",
        created_by: owner,
      })
      return c.json(await libraryJson(c, library, { entries: [] }), 201)
    },
  )

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/template-libraries/{id}",
      tags: ["Templates"],
      summary: "Read one accessible library and its reusable entries.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Library and entries.",
          content: { "application/json": { schema: Library } },
        },
      },
    }),
    async (c) => {
      const library = await requireLibrary(c)
      if (library instanceof Response) return bail(library)
      return c.json(
        await libraryJson(c, library, {
          entries: await meta.listTemplateLibraryEntries(library.id),
        }),
      )
    },
  )

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/template-libraries/{id}",
      tags: ["Templates"],
      summary: "Rename, describe, or change a library's distribution scope.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Updated library.",
          content: { "application/json": { schema: Library } },
        },
      },
    }),
    async (c) => {
      const library = await requireManagedLibrary(c)
      if (library instanceof Response) return bail(library)
      const rateLimited = await limited(c, publishLimiter)
      if (rateLimited) return bail(rateLimited)
      const body = await readJson(
        c,
        z.object({
          title: z.string().trim().min(1).max(120).optional(),
          description: z.string().trim().max(500).optional(),
          scope: Scope.optional(),
        }),
      )
      if (body instanceof Response) return bail(body)
      const mutation = await beginManagedMutation(c, library)
      if (mutation instanceof Response) return bail(mutation)
      try {
        const fresh = mutation.library
        if (
          body.scope &&
          body.scope !== fresh.scope &&
          !(await scopeCanDistributeEntries(c, fresh, body.scope))
        )
          return bail(
            fail(
              c,
              403,
              "one or more starters cannot be shared at that library scope; change their access or remove them first",
            ),
          )
        const updated = await meta.updateTemplateLibrary(fresh.id, body)
        if (!updated) return bail(fail(c, 404, "not found"))
        return c.json(await libraryJson(c, updated))
      } finally {
        await meta.releaseTemplateLibraryMutation(library.id, mutation.token)
      }
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/template-libraries/{id}",
      tags: ["Templates"],
      summary: "Delete a library and its entries; source artifacts remain untouched.",
      request: { params: z.object({ id: z.string() }) },
      responses: { 204: { description: "Deleted." } },
    }),
    async (c) => {
      const library = await requireManagedLibrary(c)
      if (library instanceof Response) return bail(library)
      const rateLimited = await limited(c, publishLimiter)
      if (rateLimited) return bail(rateLimited)
      const mutation = await beginManagedMutation(c, library)
      if (mutation instanceof Response) return bail(mutation)
      try {
        await meta.deleteTemplateLibrary(mutation.library.id)
        return c.body(null, 204)
      } finally {
        await meta.releaseTemplateLibraryMutation(library.id, mutation.token)
      }
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/template-libraries/{id}/entries",
      tags: ["Templates"],
      summary: "Publish a pinned artifact version as a reusable template entry.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        201: {
          description: "Published entry.",
          content: { "application/json": { schema: Entry } },
        },
      },
    }),
    async (c) => {
      const library = await requireManagedLibrary(c)
      if (library instanceof Response) return bail(library)
      const rateLimited = await limited(c, publishLimiter)
      if (rateLimited) return bail(rateLimited)
      const body = await readJson(
        c,
        z.object({
          source_short_id: z.string().trim().min(1),
          source_version: z.number().int().positive().optional(),
          kind: EntryKind,
          category: z.string().trim().min(1).max(64),
          title: z.string().trim().min(1).max(120),
          description: z.string().trim().max(500),
          outcome: z.string().trim().max(300),
          sections: z.array(z.string().trim().min(1).max(120)).max(30),
          inputs: z.array(Input).max(20),
          tags: z.array(z.string().trim().min(1).max(48)).max(20),
        }),
      )
      if (body instanceof Response) return bail(body)
      // Match ordinary Derive links as well as a bare short id. A publisher can
      // paste `decision-memo-ab12cd34@v4` from the address bar without first
      // extracting the id; its explicit source_version still wins if supplied.
      const sourceRef = parseRef(body.source_short_id)
      const source = await meta.getByShortId(sourceRef.shortId)
      if (!source || source.removed_at || !(await authorize(c, "read", source)))
        return bail(fail(c, 404, "not found"))
      const versionNumber = body.source_version ?? sourceRef.version ?? source.current_version
      const version = await meta.getVersion(source.id, versionNumber)
      if (!version) return bail(fail(c, 404, "not found"))
      if (source.kind !== "file")
        return bail(
          fail(
            c,
            422,
            "template libraries currently support single-file Markdown, HTML, and Derive decks; bundles are not yet supported",
          ),
        )
      const format =
        version.content_type === "text/markdown"
          ? ("md" as const)
          : version.content_type === "text/html" || version.content_type === "text/x-derive-deck"
            ? ("html" as const)
            : null
      if (!format)
        return bail(
          fail(c, 422, "template libraries currently support Markdown, HTML, and Derive decks"),
        )
      // Verify that the snapshot is materializable before advertising it. This
      // also rejects a broken bundle manifest instead of creating a dead card.
      const starter = await sourceText(version)
      if (starter === null) return bail(fail(c, 409, "source unavailable"))
      const normalizedInputs = body.inputs.map((input) => input.name.toLowerCase())
      if (new Set(normalizedInputs).size !== normalizedInputs.length)
        return bail(fail(c, 422, "template input names must be unique"))
      if (format === "html") {
        const unsafeBindings = unsafeHtmlTemplateBindings(starter, body.inputs)
        if (unsafeBindings.length)
          return bail(
            fail(
              c,
              422,
              `HTML template inputs must appear in visible text, not tags, scripts, or styles: ${unsafeBindings.join(", ")}`,
            ),
          )
      }
      const owner = await managerFor(c)
      if (!owner) return bail(fail(c, 401, "unauthenticated"))
      const mutation = await beginManagedMutation(c, library)
      if (mutation instanceof Response) return bail(mutation)
      try {
        const fresh = mutation.library
        if (((await meta.countTemplateLibraryEntries([fresh.id]))[fresh.id] ?? 0) >= 200)
          return bail(fail(c, 409, "this template library already has 200 starters"))
        if (!(await canDistribute(c, source, fresh.scope, fresh.org_id)))
          return bail(
            fail(
              c,
              403,
              "you can read this source, but you cannot distribute it at this library scope",
            ),
          )
        const secrets =
          body.kind === "context" || fresh.scope === "public" ? likelySecrets(starter) : []
        if (secrets.length)
          return bail(
            fail(
              c,
              422,
              `template looks like it contains ${secrets.join(", ")}; replace credentials with named bindings such as {{API_KEY}}`,
            ),
          )
        const entry = await meta.createTemplateLibraryEntry({
          id: newId("tpl"),
          library_id: fresh.id,
          source_artifact_id: source.id,
          source_version: version.n,
          source_blob_key: version.blob_key,
          source_content_type: version.content_type,
          kind: body.kind,
          category: version.content_type === "text/x-derive-deck" ? "Deck" : body.category,
          format,
          title: body.title,
          description: body.description,
          outcome: body.outcome,
          sections_json: JSON.stringify(body.sections),
          inputs_json: JSON.stringify(body.inputs),
          tags_json: JSON.stringify(body.tags),
          created_by: owner,
        })
        return c.json(templateLibraryEntryJson(entry), 201)
      } finally {
        await meta.releaseTemplateLibraryMutation(library.id, mutation.token)
      }
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/template-libraries/{id}/entries/{entryId}",
      tags: ["Templates"],
      summary: "Remove a reusable entry without changing its source artifact.",
      request: { params: z.object({ id: z.string(), entryId: z.string() }) },
      responses: { 204: { description: "Deleted." } },
    }),
    async (c) => {
      const library = await requireManagedLibrary(c)
      if (library instanceof Response) return bail(library)
      const rateLimited = await limited(c, publishLimiter)
      if (rateLimited) return bail(rateLimited)
      const mutation = await beginManagedMutation(c, library)
      if (mutation instanceof Response) return bail(mutation)
      try {
        const entry = await meta.getTemplateLibraryEntry(c.req.param("entryId"))
        if (!entry || entry.library_id !== mutation.library.id)
          return bail(fail(c, 404, "not found"))
        await meta.deleteTemplateLibraryEntry(entry.id)
        return c.body(null, 204)
      } finally {
        await meta.releaseTemplateLibraryMutation(library.id, mutation.token)
      }
    },
  )

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/template-libraries/{id}/entries/{entryId}/starter",
      tags: ["Templates"],
      summary: "Read an accessible entry's pinned starter source and provenance.",
      request: { params: z.object({ id: z.string(), entryId: z.string() }) },
      responses: {
        200: {
          description: "A stable source snapshot. Editing it never changes the template entry.",
          content: {
            "application/json": {
              schema: z.object({ entry: Entry, source: z.string(), mime_type: z.string() }),
            },
          },
        },
      },
    }),
    async (c) => {
      const library = await requireLibrary(c)
      if (library instanceof Response) return bail(library)
      const entry = await meta.getTemplateLibraryEntry(c.req.param("entryId"))
      if (!entry || entry.library_id !== library.id) return bail(fail(c, 404, "not found"))
      const source = await sourceText({
        blob_key: entry.source_blob_key,
        content_type: entry.source_content_type,
      })
      if (source === null) return bail(fail(c, 410, "starter no longer available"))
      return c.json({
        entry: templateLibraryEntryJson(entry),
        source,
        mime_type: entry.source_content_type,
      })
    },
  )

  return app
}

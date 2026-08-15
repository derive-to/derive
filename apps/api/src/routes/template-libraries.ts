import { newId, parseRef, type TemplateLibraryRecord } from "@derive/core"
import { listTemplates, unsafeHtmlTemplateBindings } from "@derive-to/templates"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { bail, fail, readJson } from "../lib/http"
import { likelySecrets } from "../lib/secret-scan"
import {
  BuiltInTemplateSchema,
  CreateTemplateLibraryEntrySchema,
  CreateTemplateLibrarySchema,
  TemplateLibraryEntrySchema,
  TemplateLibraryListQuerySchema,
  TemplateLibrarySchema,
  UpdateTemplateLibrarySchema,
} from "../lib/template-library-contract"
import { parseTemplateLibraryCursor, templateLibraryCursor } from "../lib/template-library-cursor"
import { templateLibraryEntryJson } from "../lib/template-library-entry"
import { createTemplateLibraryService } from "../lib/template-library-service"

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
  const { activeWorkspace, authorize, limited, meta, publishLimiter, sourceText, workspaceCan } =
    ctx
  const app = new OpenAPIHono<BlankEnv>()

  const {
    readerFor,
    managerFor,
    canDistribute,
    scopeCanDistributeEntries,
    libraryJson,
    requireLibrary,
    requireManagedLibrary,
    beginManagedMutation,
    renewManagedMutation,
  } = createTemplateLibraryService(ctx)

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
            "application/json": { schema: z.object({ templates: z.array(BuiltInTemplateSchema) }) },
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
      request: { query: TemplateLibraryListQuerySchema },
      responses: {
        200: {
          description:
            "Libraries the caller can discover. Public libraries are available anonymously.",
          content: {
            "application/json": {
              schema: z.object({
                libraries: z.array(TemplateLibrarySchema),
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
      const before = parseTemplateLibraryCursor(query.cursor)
      if (before === null) return bail(fail(c, 422, "invalid template-library cursor"))
      const limit = query.limit ?? 100
      const owner = await readerFor(c)
      const orgId = await activeWorkspace(c)
      const canReadWorkspace = await workspaceCan(c, "read")
      const [publicLibraries, workspaceLibraries, personalLibraries] = await Promise.all([
        !query.scope || query.scope === "public"
          ? meta.listTemplateLibraries({
              scope: "public",
              query: query.q,
              before,
              limit: limit + 1,
            })
          : [],
        canReadWorkspace && (!query.scope || query.scope === "workspace")
          ? meta.listTemplateLibraries({
              orgId,
              scope: "workspace",
              query: query.q,
              before,
              limit: limit + 1,
            })
          : [],
        owner && (!query.scope || query.scope === "private")
          ? meta.listTemplateLibraries({
              orgId,
              scope: "private",
              createdBy: owner,
              query: query.q,
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
            ? templateLibraryCursor(libraries[libraries.length - 1] as TemplateLibraryRecord)
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
          content: { "application/json": { schema: TemplateLibrarySchema } },
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
      const body = await readJson(c, CreateTemplateLibrarySchema)
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
          content: { "application/json": { schema: TemplateLibrarySchema } },
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
          content: { "application/json": { schema: TemplateLibrarySchema } },
        },
      },
    }),
    async (c) => {
      const library = await requireManagedLibrary(c)
      if (library instanceof Response) return bail(library)
      const rateLimited = await limited(c, publishLimiter)
      if (rateLimited) return bail(rateLimited)
      const body = await readJson(c, UpdateTemplateLibrarySchema)
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
        const staleMutation = await renewManagedMutation(c, mutation)
        if (staleMutation) return bail(staleMutation)
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
        const staleMutation = await renewManagedMutation(c, mutation)
        if (staleMutation) return bail(staleMutation)
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
          content: { "application/json": { schema: TemplateLibraryEntrySchema } },
        },
      },
    }),
    async (c) => {
      const library = await requireManagedLibrary(c)
      if (library instanceof Response) return bail(library)
      const rateLimited = await limited(c, publishLimiter)
      if (rateLimited) return bail(rateLimited)
      const body = await readJson(c, CreateTemplateLibraryEntrySchema)
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
        const staleMutation = await renewManagedMutation(c, mutation)
        if (staleMutation) return bail(staleMutation)
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
        const staleMutation = await renewManagedMutation(c, mutation)
        if (staleMutation) return bail(staleMutation)
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
              schema: z.object({
                entry: TemplateLibraryEntrySchema,
                source: z.string(),
                mime_type: z.string(),
              }),
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

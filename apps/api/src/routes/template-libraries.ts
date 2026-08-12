import {
  newId,
  parseRef,
  type TemplateLibraryEntryRecord,
  type TemplateLibraryRecord,
} from "@derive/core"
import { unsafeHtmlTemplateBindings } from "@derive-to/templates"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { bail, fail, readJson } from "../lib/http"

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
    isToken,
    managementPrincipal,
    membershipOf,
    meta,
    sourceText,
    workspaceCan,
  } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  const Scope = z.enum(["private", "workspace", "public"])
  const EntryKind = z.enum(["artifact", "context"])
  const EntryFormat = z.enum(["md", "html"])
  const Input = z.object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(240),
    required: z.boolean().optional(),
  })

  const Entry = z
    .object({
      id: z.string(),
      library_id: z.string(),
      source_artifact_id: z.string().describe("Provenance source; never used to read the starter."),
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
      created_by: z.string(),
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
      org_id: z.string(),
      title: z.string(),
      description: z.string(),
      scope: Scope.describe(
        "private = owner only; workspace = workspace members; public = anyone with the library URL or catalog.",
      ),
      created_by: z.string(),
      created_at: z.string(),
      updated_at: z.string().nullable(),
      entry_count: z.number(),
      entries: z.array(Entry).optional(),
      publisher: Publisher,
      can_manage: z.boolean().optional(),
    })
    .openapi("TemplateLibrary")

  // JSON metadata is authored through the API but parsed defensively so an old
  // hand-edited database row cannot make a whole library unreadable.
  const array = <T>(raw: string, is: (value: unknown) => value is T): T[] => {
    try {
      const value = JSON.parse(raw)
      return Array.isArray(value) ? value.filter(is) : []
    } catch {
      return []
    }
  }
  const entryJson = (entry: TemplateLibraryEntryRecord) => ({
    id: entry.id,
    library_id: entry.library_id,
    source_artifact_id: entry.source_artifact_id,
    source_version: entry.source_version,
    kind: entry.kind,
    category: entry.category,
    format: entry.format,
    title: entry.title,
    description: entry.description,
    outcome: entry.outcome,
    sections: array(entry.sections_json, (value): value is string => typeof value === "string"),
    inputs: array(
      entry.inputs_json,
      (value): value is { name: string; description: string; required?: boolean } =>
        !!value &&
        typeof value === "object" &&
        typeof (value as { name?: unknown }).name === "string" &&
        typeof (value as { description?: unknown }).description === "string" &&
        ((value as { required?: unknown }).required === undefined ||
          typeof (value as { required?: unknown }).required === "boolean"),
    ),
    tags: array(entry.tags_json, (value): value is string => typeof value === "string"),
    created_by: entry.created_by,
    created_at: entry.created_at,
  })

  const ownerFor = async (c: Context): Promise<string | null> =>
    (await managementPrincipal(c)) ?? (isToken(c) ? "token" : null)

  // Context templates are portable manifests, never secret containers. Permit
  // descriptive prose and {{PLACEHOLDER}} bindings, but refuse values that look
  // like an actual bearer/API/client secret before a library can distribute it.
  const hasContextCredential = (source: string) =>
    /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|authorization)\b\s*[:=]\s*["']?(?!\{\{)[A-Za-z0-9_\-/+=]{12,}/i.test(
      source,
    )

  const canRead = async (c: Context, library: TemplateLibraryRecord): Promise<boolean> => {
    if (library.scope === "public" || isToken(c)) return true
    // A workspace library has no cross-workspace ACL by design. The active
    // workspace check also makes an OAuth/MCP connection respect its selected
    // workspace rather than using a browser-session-only membership check.
    if ((await activeWorkspace(c)) !== library.org_id || !(await workspaceCan(c, "read")))
      return false
    return library.scope === "workspace" || library.created_by === (await ownerFor(c))
  }
  const canManage = async (c: Context, library: TemplateLibraryRecord): Promise<boolean> => {
    const owner = await ownerFor(c)
    const active = await activeWorkspace(c)
    if (active !== library.org_id || !(await workspaceCan(c, "publish"))) return false
    if (isToken(c) || library.created_by === owner) return true
    return !!owner && (await membershipOf(c, library.org_id, owner))?.role === "owner"
  }

  const libraryJson = async (
    c: Context,
    library: TemplateLibraryRecord,
    opts?: {
      entries?: TemplateLibraryEntryRecord[]
      publisher?: { name: string | null; username: string | null; image: string | null }
    },
  ) => {
    const entries = opts?.entries ?? (await meta.listTemplateLibraryEntries(library.id))
    const publisher = opts?.publisher ??
      (await meta.getUsers([library.created_by]))[0] ?? { name: null, username: null, image: null }
    return {
      ...library,
      entry_count: entries.length,
      ...(opts?.entries ? { entries: entries.map(entryJson) } : {}),
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

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/template-libraries",
      tags: ["Templates"],
      summary: "List public libraries plus libraries accessible in the active workspace.",
      responses: {
        200: {
          description:
            "Libraries the caller can discover. Public libraries are available anonymously.",
          content: { "application/json": { schema: z.object({ libraries: z.array(Library) }) } },
        },
      },
    }),
    async (c) => {
      const owner = await ownerFor(c)
      const orgId = await activeWorkspace(c)
      const canReadWorkspace = await workspaceCan(c, "read")
      const [publicLibraries, workspaceLibraries, personalLibraries] = await Promise.all([
        meta.listTemplateLibraries({ scope: "public" }),
        canReadWorkspace ? meta.listTemplateLibraries({ orgId, scope: "workspace" }) : [],
        owner ? meta.listTemplateLibraries({ orgId, scope: "private", createdBy: owner }) : [],
      ])
      const seen = new Set<string>()
      const libraries = [...personalLibraries, ...workspaceLibraries, ...publicLibraries]
        .filter((library) => {
          if (seen.has(library.id)) return false
          seen.add(library.id)
          return true
        })
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
      const publishers = new Map(
        (await meta.getUsers(libraries.map((library) => library.created_by))).map((user) => [
          user.id,
          user,
        ]),
      )
      return c.json({
        libraries: await Promise.all(
          libraries.map((library) =>
            libraryJson(c, library, { publisher: publishers.get(library.created_by) }),
          ),
        ),
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
      const owner = await ownerFor(c)
      if (!owner) return bail(fail(c, 401, "unauthenticated"))
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
        org_id: await activeWorkspace(c),
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
      const body = await readJson(
        c,
        z.object({
          title: z.string().trim().min(1).max(120).optional(),
          description: z.string().trim().max(500).optional(),
          scope: Scope.optional(),
        }),
      )
      if (body instanceof Response) return bail(body)
      const updated = await meta.updateTemplateLibrary(library.id, body)
      if (!updated) return bail(fail(c, 404, "not found"))
      return c.json(await libraryJson(c, updated))
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
      await meta.deleteTemplateLibrary(library.id)
      return c.body(null, 204)
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
      if (!source || !(await authorize(c, "read", source))) return bail(fail(c, 404, "not found"))
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
      if (body.kind === "context" && hasContextCredential(starter))
        return bail(
          fail(
            c,
            422,
            "context templates cannot contain credentials; use a named binding or {{PLACEHOLDER}} instead",
          ),
        )
      const owner = await ownerFor(c)
      if (!owner) return bail(fail(c, 401, "unauthenticated"))
      const entry = await meta.createTemplateLibraryEntry({
        id: newId("tpl"),
        library_id: library.id,
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
      return c.json(entryJson(entry), 201)
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
      const entry = await meta.getTemplateLibraryEntry(c.req.param("entryId"))
      if (!entry || entry.library_id !== library.id) return bail(fail(c, 404, "not found"))
      await meta.deleteTemplateLibraryEntry(entry.id)
      return c.body(null, 204)
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
      return c.json({ entry: entryJson(entry), source, mime_type: entry.source_content_type })
    },
  )

  return app
}

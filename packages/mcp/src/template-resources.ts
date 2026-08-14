import { catalogResource, templateResource } from "@derive-to/templates"
import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Variables } from "@modelcontextprotocol/sdk/shared/uriTemplate.js"
import type { DeriveClient, TemplateLibraryEntryJson, TemplateLibraryJson } from "./client"

// Kept deliberately small so the executable stdio entry and its test share the
// registration contract. The remote server reads the same data directly from the
// portable package; neither server owns a second catalog.
export type TemplateResourceRegistrar = Pick<McpServer, "registerResource">

const TEMPLATE_LIBRARY_CATALOG_URI = "derive://template-libraries"
const TEMPLATE_LIBRARY_ID = /^[A-Za-z0-9_-]+$/
// MCP is intentionally an HTTP-only client and cannot import core at runtime.
// Keep one validating formatter at this boundary instead of interpolating URIs
// throughout each resource serializer.
const templateLibraryUri = (libraryId: string, entryId?: string): string => {
  if (!TEMPLATE_LIBRARY_ID.test(libraryId) || (entryId && !TEMPLATE_LIBRARY_ID.test(entryId)))
    throw new Error("invalid template library URI id")
  return entryId
    ? `${TEMPLATE_LIBRARY_CATALOG_URI}/${libraryId}/${entryId}`
    : `${TEMPLATE_LIBRARY_CATALOG_URI}/${libraryId}`
}

export function registerTemplateResources(server: TemplateResourceRegistrar): void {
  const catalog = catalogResource()
  server.registerResource(
    "templates:catalog",
    catalog.uri,
    {
      title: catalog.title,
      description: catalog.description,
      mimeType: catalog.mimeType,
      annotations: { audience: ["assistant"], priority: 0.85 },
    },
    async (uri: URL) => ({
      contents: [{ uri: uri.href, mimeType: catalog.mimeType, text: catalog.text }],
    }),
  )
  server.registerResource(
    "templates:entry",
    new ResourceTemplate("derive://templates/{id}", { list: undefined }),
    {
      title: "Derive built-in Template",
      description: "One exact built-in starter with metadata and immutable provenance.",
      mimeType: "application/json",
      annotations: { audience: ["assistant"], priority: 0.7 },
    },
    async (uri, variables) => {
      const id = pathVariable(variables, "id")
      const resource = templateResource(id)
      if (!resource) throw new Error(`No built-in template "${id}".`)
      return {
        contents: [{ uri: uri.href, mimeType: resource.mimeType, text: resource.text }],
      }
    },
  )
}

const libraryEntry = (library: TemplateLibraryJson, entry: TemplateLibraryEntryJson) => ({
  ...entry,
  uri: templateLibraryUri(library.id, entry.id),
})

const pathVariable = (variables: Variables, name: string): string => {
  const value = variables[name]
  if (typeof value !== "string") throw new Error(`missing URI variable ${name}`)
  return value
}

const templateLibraryPage = async (uri: URL, client: DeriveClient, cursor?: string) => {
  const page = await client.listTemplateLibraries(cursor)
  const nextUri = page.next_cursor
    ? `${TEMPLATE_LIBRARY_CATALOG_URI}?cursor=${encodeURIComponent(page.next_cursor)}`
    : undefined
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json" as const,
        text: JSON.stringify(
          {
            libraries: page.libraries.map((library) => ({
              id: library.id,
              title: library.title,
              description: library.description,
              scope: library.scope,
              entry_count: library.entry_count,
              uri: templateLibraryUri(library.id),
            })),
            truncated: page.truncated,
            next_uri: nextUri,
            next: nextUri ? "Read next_uri for the next catalog page." : undefined,
          },
          null,
          2,
        ),
      },
    ],
  }
}

/** Register one lazy catalog plus URI templates; startup cost stays constant. */
export function registerWorkspaceTemplateResources(
  server: TemplateResourceRegistrar,
  client: DeriveClient,
): void {
  server.registerResource(
    "template-libraries:catalog",
    TEMPLATE_LIBRARY_CATALOG_URI,
    {
      title: "Derive template libraries",
      description:
        "Accessible public, workspace, and personal template libraries. Read a library URI for entries, then an entry URI for its pinned starter source.",
      mimeType: "application/json",
      annotations: { audience: ["assistant"], priority: 0.82 },
    },
    async (uri: URL) => templateLibraryPage(uri, client),
  )
  server.registerResource(
    "template-libraries:page",
    new ResourceTemplate(`${TEMPLATE_LIBRARY_CATALOG_URI}{?cursor}`, { list: undefined }),
    {
      title: "Derive template library catalog page",
      description: "Continue an accessible template-library catalog from its next cursor.",
      mimeType: "application/json",
      annotations: { audience: ["assistant"], priority: 0.78 },
    },
    async (uri, variables) =>
      templateLibraryPage(uri, client, decodeURIComponent(pathVariable(variables, "cursor"))),
  )
  server.registerResource(
    "template-library",
    new ResourceTemplate(`${TEMPLATE_LIBRARY_CATALOG_URI}/{libraryId}`, { list: undefined }),
    {
      title: "Derive template library",
      description: "One accessible authored library and its starter URIs.",
      mimeType: "application/json",
      annotations: { audience: ["assistant"], priority: 0.76 },
    },
    async (uri, variables) => {
      const current = await client.getTemplateLibrary(pathVariable(variables, "libraryId"))
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json" as const,
            text: JSON.stringify(
              {
                ...current,
                entries: (current.entries ?? []).map((entry) => libraryEntry(current, entry)),
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )
  server.registerResource(
    "template-library-entry",
    new ResourceTemplate(`${TEMPLATE_LIBRARY_CATALOG_URI}/{libraryId}/{entryId}`, {
      list: undefined,
    }),
    {
      title: "Derive template starter",
      description: "Pinned source to adapt into a new independent artifact.",
      mimeType: "application/json",
      annotations: { audience: ["assistant"], priority: 0.74 },
    },
    async (uri, variables) => {
      const libraryId = pathVariable(variables, "libraryId")
      const entryId = pathVariable(variables, "entryId")
      const [library, starter] = await Promise.all([
        client.getTemplateLibrary(libraryId),
        client.getTemplateStarter(libraryId, entryId),
      ])
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json" as const,
            text: JSON.stringify(
              {
                ...starter.entry,
                starter: {
                  source: starter.source,
                  filename: `${starter.entry.id}.${starter.entry.format}`,
                  mime_type: starter.entry.format === "md" ? "text/markdown" : "text/html",
                  message: `Created from ${library.title}/${starter.entry.title} · source v${starter.entry.source_version}`,
                },
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )
}

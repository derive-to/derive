import { catalogResource, templateResource } from "@derive-to/templates"
import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Variables } from "@modelcontextprotocol/sdk/shared/uriTemplate.js"
import type { DeriveClient, TemplateLibraryEntryJson, TemplateLibraryJson } from "./client"

// Kept deliberately small so the executable stdio entry and its test share the
// registration contract. The remote server reads the same data directly from the
// portable package; neither server owns a second catalog.
export type TemplateResourceRegistrar = Pick<McpServer, "registerResource">

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
  uri: `derive://template-libraries/${library.id}/${entry.id}`,
})

const pathVariable = (variables: Variables, name: string): string => {
  const value = variables[name]
  if (typeof value !== "string") throw new Error(`missing URI variable ${name}`)
  return value
}

/** Register one lazy catalog plus URI templates; startup cost stays constant. */
export function registerWorkspaceTemplateResources(
  server: TemplateResourceRegistrar,
  client: DeriveClient,
): void {
  server.registerResource(
    "template-libraries:catalog",
    "derive://template-libraries",
    {
      title: "Derive template libraries",
      description:
        "Accessible public, workspace, and personal template libraries. Read a library URI for entries, then an entry URI for its pinned starter source.",
      mimeType: "application/json",
      annotations: { audience: ["assistant"], priority: 0.82 },
    },
    async (uri: URL) => {
      const page = await client
        .listTemplateLibraries()
        .catch(() => ({ libraries: [], truncated: false, next_cursor: null }))
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
                  uri: `derive://template-libraries/${library.id}`,
                })),
                truncated: page.truncated,
                next: page.truncated
                  ? "Use find with templates:true to search the full catalog."
                  : undefined,
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
    "template-library",
    new ResourceTemplate("derive://template-libraries/{libraryId}", { list: undefined }),
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
    new ResourceTemplate("derive://template-libraries/{libraryId}/{entryId}", {
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

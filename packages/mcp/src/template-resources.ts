import { templateResources } from "@derive-to/templates"
import type { DeriveClient, TemplateLibraryEntryJson, TemplateLibraryJson } from "./client"

type ResourceMetadata = {
  title: string
  description: string
  mimeType: "application/json"
  annotations: { audience: "assistant"[]; priority: number }
}

type ResourceRead = (uri: URL) => Promise<{
  contents: { uri: string; mimeType: "application/json"; text: string }[]
}>

// Kept deliberately small so the executable stdio entry and its test share the
// registration contract. The remote server reads the same data directly from the
// portable package; neither server owns a second catalog.
export type TemplateResourceRegistrar = {
  registerResource: (
    name: string,
    uri: string,
    metadata: ResourceMetadata,
    read: ResourceRead,
  ) => unknown
}

export function registerTemplateResources(server: TemplateResourceRegistrar): void {
  for (const resource of templateResources()) {
    server.registerResource(
      `templates:${resource.uri}`,
      resource.uri,
      {
        title: resource.title,
        description: resource.description,
        mimeType: resource.mimeType,
        annotations: {
          audience: ["assistant"],
          priority: resource.uri.endsWith("/catalog") ? 0.85 : 0.7,
        },
      },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: resource.mimeType, text: resource.text }],
      }),
    )
  }
}

const libraryEntry = (library: TemplateLibraryJson, entry: TemplateLibraryEntryJson) => ({
  ...entry,
  uri: `derive://template-libraries/${library.id}/${entry.id}`,
})

/**
 * Register accessible authored libraries as read-only MCP resources. The stdio
 * server fetches its catalog once at startup (restart/reconnect to refresh), while
 * each resource read fetches the current metadata/starter. No tools are added:
 * agents still read a resource then use the existing `publish` tool.
 */
export async function registerWorkspaceTemplateResources(
  server: TemplateResourceRegistrar,
  client: DeriveClient,
): Promise<void> {
  let libraries: TemplateLibraryJson[]
  try {
    libraries = await client.listTemplateLibraries()
  } catch {
    // An older self-hosted server has no library routes. Built-ins remain
    // available, preserving a graceful compatibility path.
    return
  }
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
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              libraries: libraries.map((library) => ({
                id: library.id,
                title: library.title,
                description: library.description,
                scope: library.scope,
                entry_count: library.entry_count,
                uri: `derive://template-libraries/${library.id}`,
              })),
            },
            null,
            2,
          ),
        },
      ],
    }),
  )
  for (const library of libraries) {
    const libraryUri = `derive://template-libraries/${library.id}`
    server.registerResource(
      `template-library:${library.id}`,
      libraryUri,
      {
        title: library.title,
        description: library.description || "Reusable Derive starters.",
        mimeType: "application/json",
        annotations: { audience: ["assistant"], priority: 0.76 },
      },
      async (uri) => {
        const current = await client.getTemplateLibrary(library.id)
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
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
    // Registration names must be known up-front, so use the startup snapshot for
    // entry URIs. A reconnect picks up additions; reads themselves stay fresh.
    const detail = await client.getTemplateLibrary(library.id).catch(() => null)
    for (const entry of detail?.entries ?? []) {
      const entryUri = `derive://template-libraries/${library.id}/${entry.id}`
      server.registerResource(
        `template-library-entry:${library.id}:${entry.id}`,
        entryUri,
        {
          title: `${library.title} · ${entry.title}`,
          description:
            "Pinned starter source. Publish it as a new independent artifact; never edit in place.",
          mimeType: "application/json",
          annotations: { audience: ["assistant"], priority: 0.74 },
        },
        async (uri) => {
          const starter = await client.getTemplateStarter(library.id, entry.id)
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: "application/json",
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
  }
}

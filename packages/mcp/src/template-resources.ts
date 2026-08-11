import { templateResources } from "@derive-to/templates"

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

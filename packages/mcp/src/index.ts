import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { createClient } from "./client"

const client = createClient({
  baseUrl: process.env.DOCK_SERVER ?? "http://localhost:8080",
  token: process.env.DOCK_TOKEN,
})

const server = new McpServer({ name: "dock", version: "0.1.0" })

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] })

server.registerTool(
  "publish_artifact",
  {
    description: "Publish an HTML or Markdown artifact and get a permanent URL.",
    inputSchema: {
      content: z.string().describe("The artifact's text content (HTML or Markdown)."),
      filename: z.string().describe("Filename, e.g. report.html or notes.md."),
      title: z.string().optional(),
      slug: z.string().optional(),
    },
  },
  async (args) => {
    const a = await client.publish(args)
    return text(`Published "${a.title}" → ${a.url}\nshort_id ${a.short_id} · v${a.current_version}`)
  },
)

server.registerTool(
  "publish_version",
  {
    description: "Publish a new version of an existing artifact (same URL).",
    inputSchema: {
      short_id: z.string(),
      content: z.string(),
      filename: z.string(),
      message: z.string().optional().describe("What changed in this version."),
    },
  },
  async ({ short_id, content, filename, message }) => {
    const a = await client.publish({ id: short_id, content, filename, message })
    return text(`${a.url} is now v${a.current_version}`)
  },
)

server.registerTool(
  "get_artifact",
  {
    description:
      "Read an artifact's metadata and source content for a given version (defaults to current).",
    inputSchema: { short_id: z.string(), version: z.number().int().optional() },
  },
  async ({ short_id, version }) => {
    const a = await client.get(short_id)
    const body = await client.getContent(short_id, version)
    const v = version ?? a.current_version
    return text(`# ${a.title} (v${v}/${a.current_version}, ${a.kind})\n${a.url}\n\n---\n${body}`)
  },
)

server.registerTool(
  "list_versions",
  { description: "List an artifact's version history.", inputSchema: { short_id: z.string() } },
  async ({ short_id }) => {
    const a = await client.get(short_id)
    const lines = a.versions
      .map((v) => `v${v.n} · ${v.author} · ${v.message ?? ""} · ${v.created_at}`)
      .join("\n")
    return text(`${a.title} (${a.versions.length} versions)\n${lines}`)
  },
)

await server.connect(new StdioServerTransport())

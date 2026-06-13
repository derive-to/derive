import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { createClient } from "./client"

const client = createClient({
  baseUrl: process.env.DOCK_SERVER ?? "http://localhost:8080",
  token: process.env.DOCK_TOKEN,
})

// The agent guide, served as an MCP resource (single source: SKILL.md).
const GUIDE = (() => {
  try {
    return readFileSync(fileURLToPath(new URL("../SKILL.md", import.meta.url)), "utf8")
  } catch {
    return "# Dock\nPublish, read comments, revise, reply, resolve via the dock tools."
  }
})()

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
      visibility: z.enum(["public", "link", "org", "password"]).optional(),
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
      resolves: z
        .array(z.string())
        .optional()
        .describe("Comment ids whose threads this version resolves."),
    },
  },
  async ({ short_id, content, filename, message, resolves }) => {
    const a = await client.publish({ id: short_id, content, filename, message, resolves })
    const note = resolves?.length ? ` · resolved ${resolves.length} thread(s)` : ""
    return text(`${a.url} is now v${a.current_version}${note}`)
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

server.registerTool(
  "list_comments",
  {
    description: "List comment threads on an artifact (the feedback queue). Filter by state.",
    inputSchema: { short_id: z.string(), state: z.enum(["open", "resolved"]).optional() },
  },
  async ({ short_id, state }) => {
    const comments = await client.listComments(short_id, state)
    if (comments.length === 0) return text(`No ${state ?? ""} comments.`)
    const lines = comments.map(
      (c) =>
        `[${c.id}] thread ${c.thread_id} · ${c.state} · ${c.author} · base v${c.base_version}` +
        (c.anchor ? ` · @${c.anchor}` : "") +
        `\n  ${c.body_md}`,
    )
    return text(lines.join("\n"))
  },
)

server.registerTool(
  "reply_comment",
  {
    description: "Reply in an existing comment thread (agents can discuss, not just resolve).",
    inputSchema: { short_id: z.string(), thread_id: z.string(), body_md: z.string() },
  },
  async ({ short_id, thread_id, body_md }) => {
    const c = await client.createComment(short_id, { thread_id, body_md, author: "agent" })
    return text(`Replied in thread ${c.thread_id} (comment ${c.id}).`)
  },
)

server.registerTool(
  "add_comment",
  {
    description:
      "Leave new feedback as a new thread. Optionally anchor it to a quoted span of the rendered text.",
    inputSchema: {
      short_id: z.string(),
      body_md: z.string(),
      quote: z.string().optional().describe("Exact text to anchor the comment to."),
    },
  },
  async ({ short_id, body_md, quote }) => {
    const anchor = quote ? { type: "TextQuoteSelector", exact: quote } : undefined
    const c = await client.createComment(short_id, { body_md, anchor, author: "agent" })
    return text(
      `Commented (thread ${c.thread_id}, comment ${c.id})${quote ? ` on “${quote}”` : ""}.`,
    )
  },
)

server.registerTool(
  "resolve_thread",
  {
    description: "Resolve (or reopen) the thread a comment belongs to, once feedback is handled.",
    inputSchema: {
      short_id: z.string(),
      comment_id: z.string(),
      state: z.enum(["resolved", "open"]).default("resolved"),
    },
  },
  async ({ short_id, comment_id, state }) => {
    await client.setThreadState(short_id, comment_id, state)
    return text(`Thread ${state === "resolved" ? "resolved" : "reopened"}.`)
  },
)

server.registerTool(
  "diff_versions",
  {
    description: "Show what changed between two versions (defaults to previous → current).",
    inputSchema: {
      short_id: z.string(),
      from: z.number().int().optional(),
      to: z.number().int().optional(),
    },
  },
  async ({ short_id, from, to }) => {
    const d = await client.diff(short_id, from, to)
    const body = d.ops
      .map((o) => `${o.t === "add" ? "+" : o.t === "del" ? "-" : " "} ${o.line}`)
      .join("\n")
    const adds = d.ops.filter((o) => o.t === "add").length
    const dels = d.ops.filter((o) => o.t === "del").length
    return text(`diff v${d.from} → v${d.to}  (+${adds} -${dels})\n\n${body}`)
  },
)

server.registerTool(
  "restore_version",
  {
    description: "Restore a past version as a new current revision (history is not rewritten).",
    inputSchema: { short_id: z.string(), version: z.number().int() },
  },
  async ({ short_id, version }) => {
    const a = await client.restore(short_id, version)
    return text(`Restored v${version} → ${a.url} is now v${a.current_version}.`)
  },
)

server.registerTool(
  "view_stats",
  {
    description: "Read view analytics for an artifact (total, unique viewers, per-version).",
    inputSchema: { short_id: z.string() },
  },
  async ({ short_id }) => {
    const s = await client.viewStats(short_id)
    const perV = s.perVersion.map((v) => `v${v.version}: ${v.count}`).join(", ")
    return text(`${s.total} views · ${s.unique} unique${perV ? `\nby version — ${perV}` : ""}`)
  },
)

// Expose the agent loop as an MCP resource so any client can read the conventions.
server.registerResource(
  "dock-guide",
  "dock://guide",
  {
    title: "Dock agent guide",
    description: "How to run the publish → review → revise loop.",
    mimeType: "text/markdown",
  },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE }] }),
)

await server.connect(new StdioServerTransport())

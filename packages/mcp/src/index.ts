import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { createClient } from "./client"

// Stdio MCP server for self-hosters: `npx @derive/mcp` talks to a Derive instance over
// the /v1 HTTP API (DERIVE_SERVER) with a bearer (DERIVE_TOKEN). It exposes the SAME five
// tools as the remote /mcp server — list_artifacts, read, catch_up, comment, publish —
// so the vocabulary is identical whether an agent connects over OAuth or a static
// token. (A static token already has publish rights, so publish here goes live unless
// you pass for_review; bundle publishing is remote-only.)

const client = createClient({
  baseUrl: process.env.DERIVE_SERVER ?? "http://localhost:8080",
  token: process.env.DERIVE_TOKEN,
})

// The agent guide, served as an MCP resource (single source: SKILL.md).
const GUIDE = (() => {
  try {
    return readFileSync(fileURLToPath(new URL("../SKILL.md", import.meta.url)), "utf8")
  } catch {
    return "# Derive\nFind, read, catch_up, comment, and publish via the derive tools."
  }
})()

const server = new McpServer({ name: "derive", version: "1.0.0" })

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] })
const json = (v: unknown) => text(JSON.stringify(v, null, 2))

// FIND ------------------------------------------------------------------------
server.registerTool(
  "list_artifacts",
  {
    description:
      "List the artifacts in your workspace — short id, title, kind, current version, visibility. Start here to find what to work on, then catch_up or read it.",
    inputSchema: { query: z.string().optional().describe("Optional title search filter.") },
  },
  async ({ query }) => {
    const arts = await client.list(query)
    return json({ count: arts.length, artifacts: arts })
  },
)

// READ CONTENT ----------------------------------------------------------------
server.registerTool(
  "read",
  {
    description:
      "Read an artifact's CONTENT by short id (a past `version` defaults to current). For what CHANGED or the comment threads, use catch_up instead.",
    inputSchema: {
      short_id: z.string(),
      version: z.number().int().optional().describe("Defaults to the current version."),
    },
  },
  async ({ short_id, version }) => {
    const a = await client.get(short_id)
    const body = await client.getContent(short_id, version)
    const v = version ?? a.current_version
    return json({ short_id, title: a.title, kind: a.kind, version: v, content: body })
  },
)

// CATCH UP — state, feedback, history, and diffs all in one -------------------
server.registerTool(
  "catch_up",
  {
    description:
      "START HERE on an artifact. Its state in one call: a summary, the versions since `since_version`, the open (and outdated) comment threads, and the full version history. " +
      "Pass `comments` (open / addressed / resolved / outdated) to instead get that filtered thread list — your feedback queue. " +
      "Pass `response_format='detailed'` (optionally with `since_version`/`to_version`) to fold in the exact line diff between two versions.",
    inputSchema: {
      short_id: z.string(),
      since_version: z
        .number()
        .int()
        .optional()
        .describe("The version you last saw (diff base). Defaults to to_version − 1."),
      to_version: z
        .number()
        .int()
        .optional()
        .describe("Compare up to this version instead of the current one."),
      comments: z
        .enum(["open", "addressed", "resolved", "outdated"])
        .optional()
        .describe(
          "Return ONLY this state's comment threads (the feedback queue) instead of the delta.",
        ),
      response_format: z
        .enum(["summary", "detailed"])
        .optional()
        .describe("'summary' (default) omits the line diff; 'detailed' includes it."),
    },
  },
  async ({ short_id, since_version, to_version, comments, response_format }) => {
    const summarizeComment = (c: {
      thread_id: string
      author: string
      state: string
      anchor: string | null
      body_md: string
    }) => ({
      thread: c.thread_id,
      author: c.author,
      state: c.state,
      quote: c.anchor,
      body: c.body_md,
    })

    if (comments) {
      const list = await client.listComments(short_id, comments)
      return json({
        short_id,
        comments_state: comments,
        count: list.length,
        comments: list.map(summarizeComment),
      })
    }

    const a = await client.get(short_id)
    const head = a.current_version
    const to = Math.min(head, Math.max(1, to_version ?? head))
    const since = Math.min(to, Math.max(1, since_version ?? to - 1))
    const history = a.versions.slice().sort((x, y) => y.n - x.n)
    const newVersions = history.filter((v) => v.n > since && v.n <= to)
    const [open, outdated, addressed] = await Promise.all([
      client.listComments(short_id, "open"),
      client.listComments(short_id, "outdated"),
      client.listComments(short_id, "addressed"),
    ])
    let entryDiff: string | undefined
    if (response_format === "detailed" && since < to) {
      const d = await client.diff(short_id, since, to)
      entryDiff = d.ops
        .map((o) => `${o.t === "add" ? "+" : o.t === "del" ? "-" : " "} ${o.line}`)
        .join("\n")
    }
    const outdatedBit = outdated.length ? ` ${outdated.length} now outdated.` : ""
    const addressedBit = addressed.length ? ` ${addressed.length} addressed (pending review).` : ""
    const summary =
      since >= to
        ? `You're up to date on "${a.title}" (v${head}); ${open.length} open comment(s).${addressedBit}${outdatedBit}`
        : `"${a.title}": ${newVersions.length} new version(s) since v${since} (now v${to}). ${open.length} open comment(s).${addressedBit}${outdatedBit}`
    return json({
      summary,
      short_id,
      since,
      to,
      head,
      caught_up: since >= to,
      versions: history,
      new_versions: newVersions,
      ...(entryDiff
        ? { entry_diff: entryDiff }
        : {
            entry_diff: "(omitted) — call again with response_format='detailed' for the line diff.",
          }),
      open_comments: open.map(summarizeComment),
      ...(outdated.length ? { outdated_comments: outdated.map(summarizeComment) } : {}),
    })
  },
)

// COMMENT — leave / reply / resolve feedback ----------------------------------
server.registerTool(
  "comment",
  {
    description:
      "Leave feedback, reply in a thread, and/or resolve or reopen a thread. Anchor a NEW comment to a quoted span with `quote`. Reply by passing the thread id as `reply_to`. Resolve/reopen by passing `set_state` with a `comment_id` from the thread (or the comment you just left).",
    inputSchema: {
      short_id: z.string(),
      body: z
        .string()
        .optional()
        .describe("The comment text. Omit when only changing thread state."),
      reply_to: z
        .string()
        .optional()
        .describe("A thread id to reply in; omit to start a new thread."),
      quote: z.string().optional().describe("Exact text to anchor a NEW comment to."),
      set_state: z.enum(["resolved", "open"]).optional().describe("Resolve or reopen a thread."),
      comment_id: z
        .string()
        .optional()
        .describe("A comment in the thread to set_state on (when not posting)."),
    },
  },
  async ({ short_id, body, reply_to, quote, set_state, comment_id }) => {
    if (!body && !set_state)
      return text("Provide `body` (to comment) or `set_state` (to resolve/reopen).")
    let posted: Awaited<ReturnType<typeof client.createComment>> | undefined
    if (body) {
      const anchor = quote ? { type: "TextQuoteSelector", exact: quote } : undefined
      posted = await client.createComment(short_id, {
        thread_id: reply_to,
        body_md: body,
        anchor,
        author: "agent",
      })
    }
    let stateNote = ""
    if (set_state) {
      const ref = posted?.id ?? comment_id
      if (!ref)
        return text(
          "`set_state` needs a `comment_id` (a comment in the thread) or a `body` to post and resolve.",
        )
      await client.setThreadState(short_id, ref, set_state)
      stateNote = ` · thread ${set_state === "resolved" ? "resolved" : "reopened"}`
    }
    if (posted) {
      const where = reply_to
        ? `replied in thread ${posted.thread_id}`
        : `new thread ${posted.thread_id}`
      return text(`${where} (comment ${posted.id})${quote ? ` on “${quote}”` : ""}${stateNote}.`)
    }
    return text(`Thread ${set_state === "resolved" ? "resolved" : "reopened"}.`)
  },
)

// WRITE — publish live, or file a proposal for review -------------------------
server.registerTool(
  "publish",
  {
    description:
      "Publish a single-file artifact and get a permanent URL. OMIT short_id to create a NEW artifact (title recommended); PASS short_id to publish a new version (same URL). Pass for_review:true to file it as a PROPOSAL a human approves instead of going live. Pass `addresses` with the thread ids this revision resolves. (Multi-page bundles are published via the web app or the remote /mcp server.)",
    inputSchema: {
      content: z.string().describe("The artifact's text content (HTML or Markdown)."),
      filename: z
        .string()
        .optional()
        .describe("Filename, e.g. report.html or notes.md. Defaults to index.html."),
      short_id: z
        .string()
        .optional()
        .describe("Omit to create a new artifact; pass it to add a version."),
      title: z.string().optional(),
      // `password` stays CLI/web-only (it needs a password argument this tool
      // doesn't take). Omitted ⇒ the server default, workspace-only `org`.
      visibility: z.enum(["public", "link", "org", "private"]).optional(),
      message: z.string().optional().describe("What changed in this version."),
      for_review: z
        .boolean()
        .optional()
        .describe("File as a proposal for human review instead of publishing live."),
      addresses: z
        .array(z.string())
        .optional()
        .describe("Thread ids this revision resolves (live publish) or addresses (proposal)."),
    },
  },
  async ({ content, filename, short_id, title, visibility, message, for_review, addresses }) => {
    if (for_review) {
      if (!short_id) return text("A proposal revises an EXISTING artifact — pass its short_id.")
      const p = await client.propose(short_id, {
        content,
        filename,
        message: message ?? "Proposed revision",
        addresses,
      })
      const note = p.addressed?.length ? ` · addressed ${p.addressed.length} thread(s)` : ""
      return json({
        proposed: true,
        proposal_id: p.id,
        base_version: p.base_version,
        note: `Submitted for review (not live)${note}.`,
      })
    }
    const a = await client.publish({
      id: short_id,
      content,
      filename: filename ?? "index.html",
      title,
      visibility,
      message,
      resolves: addresses,
    })
    const note = addresses?.length ? ` · resolved ${addresses.length} thread(s)` : ""
    return json({
      published: true,
      short_id: a.short_id,
      version: a.current_version,
      url: a.url,
      title: a.title,
      note: short_id ? `Live — new version${note}.` : `Live — created "${a.title}"${note}.`,
    })
  },
)

// Expose the agent loop as an MCP resource so any client can read the conventions.
server.registerResource(
  "derive-guide",
  "derive://guide",
  {
    title: "Derive agent guide",
    description: "How to run the publish → review → revise loop.",
    mimeType: "text/markdown",
  },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE }] }),
)

await server.connect(new StdioServerTransport())

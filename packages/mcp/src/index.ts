import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  findAccountWorkspace,
  freshToken,
  getAccount,
  getDefault,
  listAccounts,
  resolveAccountRef,
  resolveWorkspaceRef,
} from "@derive-to/cli/config"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { createClient } from "./client"

// Stdio MCP server for self-hosters: `npx @derive-to/mcp` talks to a Derive instance over
// the /v1 HTTP API (DERIVE_SERVER). It exposes the SAME tools as the remote /mcp
// server — list_workspaces, list_artifacts, read, catch_up, comment, publish — so the
// vocabulary is identical whether an agent connects over OAuth or a static token.
//
// No token to paste: by default this reads the SAME local store `derive login`
// writes (~/.config/derive/credentials.json), refreshing silently — sign in once
// on the machine and every project's MCP server just works. DERIVE_ACCOUNT /
// DERIVE_WORKSPACE pin which signed-in account/workspace THIS project acts as by
// DEFAULT (id or name); unset, it falls back to your stored default. Because one
// login reaches every workspace the account belongs to, any tool also takes a
// per-call `workspace` argument (see list_workspaces) to act in another one without
// changing that pin. DERIVE_TOKEN remains an escape hatch for a static bearer (CI,
// no local login) — DERIVE_WORKSPACE has no effect there, since a static token
// already acts as every workspace's owner.
const server_ = process.env.DERIVE_SERVER ?? "http://localhost:8080"

/** {token, workspace} for the client below — see the module doc comment for the
 *  precedence. Kept out of `createClient` itself so a resolution failure fails
 *  loudly at startup (a clear thrown message) instead of quietly targeting the
 *  wrong workspace, or surfacing as an unexplained 401 mid-session. Not signed
 *  in at all (no env override, nothing saved) degrades gracefully to anonymous,
 *  same as today's unset DERIVE_TOKEN — only an env var naming something that
 *  doesn't exist is an error. */
async function resolveAuth(): Promise<{
  token?: string
  workspace?: string
  accountId?: string
}> {
  if (process.env.DERIVE_TOKEN) return { token: process.env.DERIVE_TOKEN }

  const accountEnv = process.env.DERIVE_ACCOUNT
  const workspaceEnv = process.env.DERIVE_WORKSPACE
  let accountId: string | null
  let workspace: string | undefined

  if (accountEnv) {
    accountId = resolveAccountRef(server_, accountEnv)
    if (!accountId)
      throw new Error(
        `DERIVE_ACCOUNT "${accountEnv}" isn't signed in on this machine — run \`derive login\`.`,
      )
    if (workspaceEnv) {
      const found = findAccountWorkspace(server_, accountId, workspaceEnv)
      if (!found)
        throw new Error(
          `DERIVE_WORKSPACE "${workspaceEnv}" isn't one of that account's workspaces — run \`derive workspaces --account ${accountEnv}\`.`,
        )
      workspace = found.id
    } else {
      workspace = getAccount(server_, accountId)?.defaultWorkspace ?? undefined
    }
  } else if (workspaceEnv) {
    const resolved = resolveWorkspaceRef(server_, workspaceEnv)
    if (!resolved)
      throw new Error(
        `DERIVE_WORKSPACE "${workspaceEnv}" isn't a workspace on any signed-in account.`,
      )
    if ("ambiguous" in resolved)
      throw new Error(
        `DERIVE_WORKSPACE "${workspaceEnv}" matches workspaces under more than one account — set DERIVE_ACCOUNT too.`,
      )
    accountId = resolved.accountId
    workspace = resolved.workspaceId
  } else {
    const def = getDefault(server_)
    accountId = def?.account ?? null
    workspace = def?.workspace ?? undefined
  }

  if (!accountId) return {}
  const token = (await freshToken(server_, accountId)) ?? undefined
  return { token, workspace, accountId }
}

const { token, workspace, accountId } = await resolveAuth()
const client = createClient({ baseUrl: server_, token, workspace })

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
const err = (s: string) => ({
  content: [{ type: "text" as const, text: s }],
  isError: true as const,
})

// A content-bearing response: a frontmatter-style header, a blank line, then the
// RAW body — never JSON-escaped (parity with the remote server's envelope).
const doc = (meta: Record<string, string | number | null | undefined>, body: string) => {
  const head = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")
  return text(`---\n${head}\n---\n\n${body}`)
}

// A `workspace` arg (id or name) on any tool acts in THAT workspace for the one
// call, without re-pinning the session: the token already reaches every workspace
// the account belongs to, so we just build a throwaway client that sends the
// matching X-Derive-Workspace header. Names resolve against the active account's
// local roster; an unrecognized ref is passed through as a literal id (a static
// DERIVE_TOKEN caller has no roster to match names against). Omit → the session's
// resolved default client.
const resolveWsId = (ref: string): string => {
  if (accountId) {
    const found = findAccountWorkspace(server_, accountId, ref)
    if (found) return found.id
  }
  return ref
}
const clientFor = (ref?: string) =>
  ref ? createClient({ baseUrl: server_, token, workspace: resolveWsId(ref) }) : client
const wsArg = z
  .string()
  .optional()
  .describe(
    "Workspace to act in — its id or name from list_workspaces. Omit to use this session's default workspace.",
  )

// The signed-in roster on THIS machine (shared by the list_workspaces tool and the
// derive://workspaces resource) — read fresh so a sibling `derive login`/`describe`
// shows up mid-session.
const buildRoster = () => {
  const accounts = listAccounts(server_).map((a) => {
    const account = getAccount(server_, a.id)
    return {
      account_id: a.id,
      handle: a.handle,
      is_default_account: a.isDefault,
      workspaces: Object.entries(account?.workspaces ?? {}).map(([id, w]) => ({
        workspace_id: id,
        name: w.name,
        role: w.role,
        description: w.description ?? null,
        is_default_workspace: id === account?.defaultWorkspace,
        is_active: id === workspace,
      })),
    }
  })
  const active = accountId
    ? { server: server_, account_id: accountId, workspace_id: workspace ?? null }
    : { server: server_, note: "No signed-in account resolved for this session." }
  return { active, accounts }
}

// WORKSPACES — the switcher: every workspace signed in on this machine ---------
server.registerTool(
  "list_workspaces",
  {
    description:
      "List every workspace signed in on this machine you can act in — id, name, your role, local description, and which is active. One login reaches them all; pass a workspace's id or name as the `workspace` argument to list_artifacts / read / catch_up / comment / publish to act there for that call.",
    inputSchema: {},
  },
  async () => json(buildRoster()),
)

// FIND ------------------------------------------------------------------------
server.registerTool(
  "list_artifacts",
  {
    description:
      "List the artifacts in your workspace — short id, title, kind, current version, access. Defaults to this session's workspace; pass `workspace` (id or name from list_workspaces) to list another. Start here to find what to work on, then catch_up or read it.",
    inputSchema: {
      query: z.string().optional().describe("Optional title search filter."),
      workspace: wsArg,
    },
  },
  async ({ query, workspace: ws }) => {
    const arts = await clientFor(ws).list(query)
    return json({ count: arts.length, artifacts: arts })
  },
)

// READ CONTENT ----------------------------------------------------------------
server.registerTool(
  "read",
  {
    description:
      "Read an artifact's CONTENT by short id, as Markdown by default (HTML is converted). Omit `section` to see the outline first (heading slugs for a single-file doc, page paths for a bundle) — call again with a `section` (or \"*\" for the full document) once you know what you want. Pass `format:'html'` for the exact source (needed before publish `edits`), or a past `version` for history. For what CHANGED or the comment threads, use catch_up instead. (Older self-hosted servers that predate these params return the whole artifact regardless of section/format — noted in the response when that happens.)",
    inputSchema: {
      short_id: z.string(),
      section: z
        .string()
        .optional()
        .describe(
          'A heading slug (single-file) or page path (bundle, optionally page#slug). Pass "*" for the full document.',
        ),
      format: z
        .enum(["markdown", "text"])
        .optional()
        .describe("markdown (default, HTML converted) or text (flat visible text)."),
      version: z.number().int().optional().describe("Defaults to the current version."),
      workspace: wsArg,
    },
  },
  async ({ short_id, section, format, version, workspace: ws }) => {
    const client = clientFor(ws)
    const a = await client.get(short_id)
    const v = version ?? a.current_version

    // No section: show the outline first (mirrors the remote server's
    // outline-before-blind-dump behavior). Falls back to full content when the
    // artifact has no headings/pages, or the server predates `?outline=1`.
    if (!section) {
      const outline = await client.getOutline(short_id, version)
      if (outline.sections.length || outline.pages) {
        return json({
          short_id,
          title: a.title,
          kind: a.kind,
          version: v,
          ...(outline.sections.length ? { sections: outline.sections } : {}),
          ...(outline.pages ? { pages: outline.pages } : {}),
          next:
            outline.sections.length || outline.pages?.length
              ? 'Call read again with a `section` (a slug/page above), or section:"*" for the full document.'
              : undefined,
        })
      }
    }

    try {
      const result = await client.getContent(short_id, {
        version,
        section,
        format: format ?? "markdown",
      })
      if (!result.supportsParams)
        return doc(
          { short_id, title: a.title, kind: a.kind, version: v },
          `${result.text}\n\n[note: this server predates section/format params — returning the full raw artifact.]`,
        )
      return doc(
        {
          short_id,
          title: a.title,
          kind: a.kind,
          version: v,
          ...(result.format ? { format: result.format } : {}),
          ...(result.section ? { section: result.section } : {}),
        },
        result.text,
      )
    } catch (e) {
      return err(e instanceof Error ? e.message : "read failed")
    }
  },
)

// CATCH UP — state, feedback, history, and diffs all in one -------------------
server.registerTool(
  "catch_up",
  {
    description:
      "START HERE on an artifact. Its state in one call: a summary, the review round, the versions since `since_version`, the open (and outdated) comment threads, and the full version history. " +
      "Pass `comments` (open / addressed / resolved / outdated) to instead get that filtered thread list — your feedback queue. " +
      "Pass `response_format='detailed'` (optionally with `since_version`/`to_version`) to fold in a line diff between two versions — of their readable Markdown form, not raw HTML. " +
      "WAITING ON A REVIEW? Pass `wait` (seconds, max 50) to block until the human sends back or approves — chain these instead of sleeping between polls.",
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
      wait: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe(
          "Long-poll: block up to this many seconds for the human's next review action before returning. Returns immediately when something is already actionable.",
        ),
      workspace: wsArg,
    },
  },
  async ({
    short_id,
    since_version,
    to_version,
    comments,
    response_format,
    wait,
    workspace: ws,
  }) => {
    const client = clientFor(ws)
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

    // Long-poll (self-host shim flavor): the /v1 API has no blocking endpoint,
    // so poll every 2.5s until the human acts or the wait runs out — the same
    // contract as the remote server's wait on a coarser clock. "Acts" = the
    // round changes OR the open-comment count moves (so waiting works with no
    // round open, exactly like the server's comment.created wake). Transient
    // errors retry; they never end the wait early. A settled round that still
    // applies to the current head is already actionable and returns at once.
    if (wait) {
      const deadline = Date.now() + wait * 1000
      const snap = () =>
        Promise.all([
          client.get(short_id),
          client.getReview(short_id),
          client.listComments(short_id, "open"),
        ]).then(([art, rev, open]) => {
          const round = rev.pending ?? rev.rounds[0] ?? null
          return {
            key: `${round?.id ?? "none"}:${round?.state ?? "none"}:${open.length}`,
            actionable:
              !!round && round.state !== "pending" && round.version >= art.current_version,
          }
        })
      let baseline: string | null = null
      for (;;) {
        const cur = await snap().catch(() => null)
        if (cur) {
          if (baseline === null) {
            baseline = cur.key
            if (cur.actionable) break
          } else if (cur.key !== baseline) break
        }
        if (Date.now() >= deadline) break
        await new Promise((r) => setTimeout(r, 2500))
      }
    }

    const a = await client.get(short_id)
    const head = a.current_version
    const to = Math.min(head, Math.max(1, to_version ?? head))
    const since = Math.min(to, Math.max(1, since_version ?? to - 1))
    const history = a.versions.slice().sort((x, y) => y.n - x.n)
    const newVersions = history.filter((v) => v.n > since && v.n <= to)
    const [open, outdated, addressed, reviewState] = await Promise.all([
      client.listComments(short_id, "open"),
      client.listComments(short_id, "outdated"),
      client.listComments(short_id, "addressed"),
      client.getReview(short_id).catch(() => ({ rounds: [], pending: null })),
    ])
    const round = reviewState.pending ?? reviewState.rounds[0] ?? null
    const review = round
      ? {
          state: round.state,
          version: round.version,
          requested_at: round.created_at,
          resolved_at: round.resolved_at,
          note: round.note,
        }
      : null
    const reviewBit = review
      ? review.state === "pending"
        ? ` Review requested on v${review.version} — waiting for the human.`
        : review.state === "sent_back"
          ? ` The human sent back their review of v${review.version} — read the open threads, revise, and re-request.`
          : ` The human approved v${review.version} — you're clear to proceed.`
      : ""
    let entryDiff: string | undefined
    if (response_format === "detailed" && since < to) {
      // Diff the readable Markdown form, not raw HTML — kills tag noise and
      // avoids a minified one-line document producing one useless del/add pair.
      const d = await client.diff(short_id, since, to, "markdown")
      entryDiff = d.ops
        .map((o) => `${o.t === "add" ? "+" : o.t === "del" ? "-" : " "} ${o.line}`)
        .join("\n")
    }
    const outdatedBit = outdated.length ? ` ${outdated.length} now outdated.` : ""
    const addressedBit = addressed.length ? ` ${addressed.length} addressed (pending review).` : ""
    const summary =
      since >= to
        ? `You're up to date on "${a.title}" (v${head}); ${open.length} open comment(s).${addressedBit}${outdatedBit}${reviewBit}`
        : `"${a.title}": ${newVersions.length} new version(s) since v${since} (now v${to}). ${open.length} open comment(s).${addressedBit}${outdatedBit}${reviewBit}`
    return json({
      summary,
      review,
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
      "Leave feedback, reply in a thread, react, and/or resolve or reopen a thread. Anchor a NEW comment to a quoted span with `quote`. Reply by passing the thread id as `reply_to`. Pass `react` with a `comment_id` (or `reply_to` to hit the thread's latest comment) to acknowledge feedback without the noise of a reply — the loop's minimum ack. Resolve/reopen by passing `set_state` with a `comment_id` from the thread (or the comment you just left).",
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
      react: z
        .enum(["👍", "❤️", "🎉", "😄", "👀", "🙏", "🚀", "👎"])
        .optional()
        .describe("React to a comment (with `comment_id` or `reply_to`) — 👍 is the loop's ack."),
      set_state: z.enum(["resolved", "open"]).optional().describe("Resolve or reopen a thread."),
      comment_id: z
        .string()
        .optional()
        .describe("A comment in the thread to react to / set_state on (when not posting)."),
      workspace: wsArg,
    },
  },
  async ({ short_id, body, reply_to, quote, react, set_state, comment_id, workspace: ws }) => {
    const client = clientFor(ws)
    if (!body && !set_state && !react)
      return text(
        "Provide `body` (to comment), `react` (to acknowledge), or `set_state` (to resolve/reopen).",
      )
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
    let reactNote = ""
    if (react) {
      // The ack target: an explicit comment, else the newest comment in the
      // thread by someone ELSE — never the agent's own just-posted reply. One
      // unfiltered fetch covers every thread state (the human may have replied
      // on a resolved thread).
      const all = await client.listComments(short_id)
      let target = comment_id
      if (!target && reply_to) {
        const thread = all
          .filter((cm) => cm.thread_id === reply_to)
          .sort((x, y) => x.created_at.localeCompare(y.created_at))
        const other = [...thread].reverse().find((cm) => cm.author !== "agent")
        target = (other ?? thread[thread.length - 1])?.id
      }
      if (!target)
        return text("`react` needs a `comment_id` or a `reply_to` thread to acknowledge.")
      // The /react route TOGGLES; skipping an already-present emoji keeps a
      // retried ack from silently removing it.
      if (all.find((cm) => cm.id === target)?.reactions?.[react]?.length) {
        reactNote = ` · already acknowledged with ${react}`
      } else {
        await client.react(short_id, target, react)
        reactNote = ` · acknowledged with ${react}`
      }
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
      return text(
        `${where} (comment ${posted.id})${quote ? ` on “${quote}”` : ""}${reactNote}${stateNote}.`,
      )
    }
    if (!set_state) return text(`Acknowledged${reactNote.replace(" · acknowledged", "")}.`)
    return text(`Thread ${set_state === "resolved" ? "resolved" : "reopened"}${reactNote}.`)
  },
)

// WRITE — publish live, or file a proposal for review -------------------------
server.registerTool(
  "publish",
  {
    description:
      "Publish a single-file artifact and get a permanent URL. OMIT short_id to create a NEW artifact (title recommended); PASS short_id to publish a new version (same URL). To CHANGE PART of an existing artifact, prefer `edits` (exact-match search/replace against the stored source — read format:'html' first) over resending everything via `content`. Pass for_review:true to file it as a PROPOSAL a human approves instead of going live. Pass `addresses` with the thread ids this revision resolves. (Multi-page bundles are published via the web app or the remote /mcp server.)",
    inputSchema: {
      content: z
        .string()
        .optional()
        .describe("The artifact's full text content (HTML or Markdown). Use this OR `edits`."),
      edits: z
        .array(
          z.object({
            old_str: z
              .string()
              .describe(
                "Exact text from the STORED SOURCE (read format:'html' first on an HTML artifact). Must occur exactly once.",
              ),
            new_str: z.string().describe("Replacement text. Empty string deletes."),
          }),
        )
        .optional()
        .describe(
          "Surgical revision without resending the artifact: exact-match search/replace against the current stored source, applied in order. Errors (applying nothing) if any old_str matches zero or multiple times. Requires `short_id`; use INSTEAD of `content`.",
        ),
      base_version: z
        .number()
        .optional()
        .describe(
          "Safety check for `edits`: pass the version you read; errors instead of applying if the artifact moved past it.",
        ),
      filename: z
        .string()
        .optional()
        .describe("Filename, e.g. report.html or notes.md. Defaults to index.html."),
      short_id: z
        .string()
        .optional()
        .describe("Omit to create a new artifact; pass it to add a version."),
      title: z.string().optional(),
      // The v2 access triple for a NEW artifact (see access-model.md); omit any to
      // take the workspace default (the team draft — the human you act for owns it
      // and promotes it when ready). Ignored on a republish.
      workspace_access: z.enum(["none", "member"]).optional(),
      link_role: z.enum(["none", "viewer", "commenter", "editor"]).optional(),
      listed: z.enum(["none", "workspace", "public"]).optional(),
      message: z.string().optional().describe("What changed in this version."),
      for_review: z
        .boolean()
        .optional()
        .describe("File as a proposal for human review instead of publishing live."),
      addresses: z
        .array(z.string())
        .optional()
        .describe("Thread ids this revision resolves (live publish) or addresses (proposal)."),
      request_review: z
        .boolean()
        .optional()
        .describe(
          "Open a review round asking your human to review this version — the /derive loop. Poll catch_up's `review` (or pass `wait`) for the state.",
        ),
      workspace: wsArg,
    },
  },
  async ({
    content,
    edits,
    base_version,
    filename,
    short_id,
    title,
    workspace_access,
    link_role,
    listed,
    message,
    for_review,
    addresses,
    request_review,
    workspace: ws,
  }) => {
    const client = clientFor(ws)
    if (content !== undefined && edits) return text("Provide `content` OR `edits`, not both.")
    if (for_review) {
      if (!short_id) return text("A proposal revises an EXISTING artifact — pass its short_id.")
      try {
        const p = await client.propose(short_id, {
          content,
          edits,
          baseVersion: base_version,
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
      } catch (e) {
        return err(e instanceof Error ? e.message : "propose failed")
      }
    }
    if (edits && !short_id) return text("`edits` revises an EXISTING artifact — pass its short_id.")
    let a: Awaited<ReturnType<typeof client.publish>>
    try {
      a = await client.publish({
        id: short_id,
        content,
        edits,
        baseVersion: base_version,
        filename: filename ?? (edits ? undefined : "index.html"),
        title,
        workspaceAccess: workspace_access,
        linkRole: link_role,
        listed,
        message,
        resolves: addresses,
        requestReview: request_review,
      })
    } catch (e) {
      return err(e instanceof Error ? e.message : "publish failed")
    }
    const note = addresses?.length ? ` · resolved ${addresses.length} thread(s)` : ""
    const openNote =
      a.opened_in_tab === false
        ? " No open Derive tab caught this push — open the url for the user if they should see it now."
        : ""
    return json({
      published: true,
      short_id: a.short_id,
      ...(a.review_requested ? { review_requested: true } : {}),
      version: a.current_version,
      url: a.url,
      title: a.title,
      listed: a.listed,
      link_role: a.link_role,
      ...(a.opened_in_tab !== undefined ? { opened_in_tab: a.opened_in_tab } : {}),
      note:
        (short_id ? `Live — new version${note}.` : `Live — created "${a.title}"${note}.`) +
        openNote,
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

// Every account/workspace signed in on THIS machine, with the local `description`
// each was given via `derive workspace describe` — the context a bare name can't
// carry. This tool's OWN live calls only ever act as `active` below (fixed at
// startup by DERIVE_ACCOUNT/DERIVE_WORKSPACE or the stored default); the rest of
// the roster is visibility only, for deciding whether that pin is still the right
// one — e.g. before proposing a change to a project's .mcp.json. Read fresh (not
// cached at startup) since `derive workspace describe` can run in a sibling
// terminal mid-session.
server.registerResource(
  "derive-workspaces",
  "derive://workspaces",
  {
    title: "Signed-in accounts & workspaces",
    description:
      "Every account and workspace signed in on this machine, each with its local `description` " +
      "(what it's FOR, set via `derive workspace describe`) if one has been set. `active` is the " +
      "one this session's tools actually publish to — read this before assuming a bare workspace " +
      "name is enough context, or before touching a project's DERIVE_ACCOUNT/DERIVE_WORKSPACE pin.",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(buildRoster(), null, 2),
      },
    ],
  }),
)

await server.connect(new StdioServerTransport())

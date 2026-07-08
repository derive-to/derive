// Remote MCP endpoint — Derive as a Model Context Protocol server an AI client
// (claude.ai / Claude Code) connects to over Streamable HTTP, authenticated by the
// same OAuth 2.1 bearer the rest of the app uses. It's the transport for the agentic
// loop: connect once, see what changed (catch_up), read, comment, and publish a
// revision — no static token.
//
// Stateless + fetch-native (no Durable Object, no nodejs_compat): a fresh McpServer
// is built per request closing over the resolved agent identity, so tool calls act
// in exactly that bearer's workspace at that bearer's role. Runs identically on the
// Node tier and the Cloudflare Workers tier — same `createApp`.
//
// Tool design follows Anthropic's "Writing effective tools for agents": a small set
// shaped to the agent's workflow (not the API surface), high-signal responses with
// truncate-and-steer, semantic ids (short_id / vN / page path — never UUIDs),
// actionable errors, and identity carried in the server `instructions` rather than a
// tool slot. Five tools, one per intent — FIND (list_artifacts), READ content (read),
// CATCH UP on state/feedback/history (catch_up), COMMENT (comment), and WRITE
// (publish). Variation lives in parameters: `since_version`/`to_version` turn
// catch_up into a diff, `reply_to`/`set_state` fold reply+resolve into comment, and
// `for_review`/role turn publish into a human-reviewed proposal.

import {
  type AgentRecord,
  type ArtifactRecord,
  artifactUrl,
  type BundleManifest,
  diffLines,
  formatDiff,
  newId,
  PublishError,
  propose as proposeChange,
  publish as publishVersion,
  roleAllows,
  type VersionRecord,
} from "@derive/core"
import { StreamableHTTPTransport } from "@hono/mcp"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "./context"
import { markAddressed } from "./lib/addressed"
import { publishSweepEvents } from "./lib/anchor-sweep"
import {
  cleanPath,
  mergeBundleZip,
  manifestOf as sharedManifestOf,
  zipBundleFiles,
} from "./lib/bundle"
import { parseMeta, quoteOf, REACTIONS } from "./lib/comments"
import { buildReviewEmail } from "./lib/email"
import { enqueueChannelDelivery } from "./webhooks"

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] })
// Bound a best-effort promise (the tab-delivery receipt) so it can never stall a
// publish: past `ms`, resolve with the fallback and move on.
const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))])
const json = (v: unknown) => text(JSON.stringify(v, null, 2))
// An actionable error the model can recover from (per the MCP spec, isError text is
// fed back to the agent so it self-corrects), rather than an opaque failure.
const err = (s: string) => ({
  content: [{ type: "text" as const, text: s }],
  isError: true as const,
})

// Tool reads are bounded so a big artifact can never blow the client's context
// window (Claude caps tool responses at ~25k tokens; ~80k chars is a safe ceiling).
const MAX_CHARS = 80_000
const clip = (s: string) =>
  s.length > MAX_CHARS
    ? `${s.slice(0, MAX_CHARS)}\n\n…[truncated ${s.length - MAX_CHARS} chars — read a specific section]`
    : s

const summarizeArtifact = (a: ArtifactRecord) => ({
  short_id: a.short_id,
  title: a.title,
  kind: a.kind,
  version: a.current_version,
  visibility: a.visibility,
  removed: !!a.removed_at,
})

const summarizeVersion = (v: VersionRecord) => ({
  n: v.n,
  name: v.name,
  message: v.message,
  author: v.author,
  created_at: v.created_at,
})

const summarizeComment = (c: {
  thread_id: string
  author: string
  state?: string
  base_version?: number
  anchor: string | null
  path?: string | null
  body_md: string
}) => ({
  thread: c.thread_id,
  author: c.author,
  ...(c.state ? { state: c.state } : {}),
  ...(c.base_version != null ? { base_version: c.base_version } : {}),
  quote: quoteOf(c.anchor),
  ...(c.path ? { path: c.path } : {}),
  body: c.body_md,
})

// A version's bundle manifest, presented cleanly. Lets the loop tools see a
// multi-page artifact's actual files, not just its entry doc.
const manifestOf = (ctx: AppContext, v: VersionRecord) => sharedManifestOf(ctx.blobs, v)

// Which pages changed between two bundle versions — by comparing each file's
// content-addressed blob key. This is the "what's new" a coalesced catch-up needs.
const bundleFileChanges = (from: BundleManifest, to: BundleManifest) => ({
  added: Object.keys(to.files)
    .filter((p) => !from.files[p])
    .map(cleanPath),
  removed: Object.keys(from.files)
    .filter((p) => !to.files[p])
    .map(cleanPath),
  changed: Object.keys(to.files)
    .filter((p) => {
      const f = from.files[p]
      const t = to.files[p]
      return f && t && f.key !== t.key
    })
    .map(cleanPath),
})

const changeCount = (c: ReturnType<typeof bundleFileChanges>) =>
  c.added.length + c.changed.length + c.removed.length

/**
 * A new MCP server for one request, scoped to `agent` (the OAuth-resolved identity).
 * Tools act in the bearer's workspace at the bearer's role: reads + comments for
 * commenter+, and writes via `publish` — which goes live for an editor/owner, or is
 * filed as a human-reviewed proposal for a commenter (or anyone passing
 * `for_review`). So a low-privilege agent is a safe contributor, not a publisher.
 * Identity rides in the server `instructions` (below), not a `whoami` tool — it's a
 * one-shot fact, not a per-call action.
 */
function buildServer(
  ctx: AppContext,
  agent: AgentRecord,
  actingFor: { id: string; name: string | null } | null,
): McpServer {
  // Steer the write guidance by what this grant can actually do: a publish-capable
  // grant gets the direct-publish path; a lower grant is told its writes go to review.
  const writeGuidance = roleAllows(agent.role, "publish")
    ? `Use publish to create a new artifact (omit short_id) or push a new version of one (pass short_id) — ` +
      `it goes live immediately. Pass for_review:true to file it as a proposal a human approves instead. `
    : `Use publish to submit a revision — at your role it is filed as a proposal a human approves before it ` +
      `goes live; you cannot publish directly. `
  const server = new McpServer(
    { name: "derive", version: "1.0.0" },
    {
      instructions:
        `You are connected to Derive as "${agent.name}"${
          actingFor ? ` on behalf of ${actingFor.name ?? "your user"}` : ""
        }, acting in workspace ${agent.org_id} ` +
        `with ${agent.role} permissions. Derive hosts living documents and plans with versioned ` +
        `history, text-anchored review comments, and a publish → review → revise loop. ` +
        `Start a session with catch_up to re-sync on what changed and what feedback is open; use ` +
        `read to view content (outline first for multi-page bundles); use comment to leave or ` +
        `resolve feedback. ${writeGuidance}When a revision fixes specific feedback, pass those ` +
        `thread ids as publish's "addresses" so the threads resolve (or show pending on a proposal).`,
    },
  )
  const org = agent.org_id

  // Resolve a short id within the caller's workspace (never another org's
  // artifact). `private` narrows further: the agent touches it only through its
  // human's standing (or a legacy row of its own) — a teammate's private draft
  // is as untouchable over MCP as its listings are invisible.
  const own = async (shortId: string): Promise<ArtifactRecord | null> => {
    const a = await ctx.meta.getByShortId(shortId)
    if (!a || a.org_id !== org) return null
    if (a.visibility !== "private") return a
    if (actingFor && (await ctx.meta.getArtifactMember(a.id, actingFor.id))) return a
    if (await ctx.meta.getArtifactMember(a.id, agent.id)) return a
    return null
  }
  const notFound = (shortId: string) =>
    err(`No artifact "${shortId}" in your workspace. Call list_artifacts to see what's here.`)

  // FIND ----------------------------------------------------------------------
  server.registerTool(
    "list_artifacts",
    {
      description:
        "List the artifacts (docs, plans, sites) in your workspace — short id, title, kind, current version, visibility. Includes your own unlisted (link-only) publishes — hidden from the shared library, but you always find your work. Start here to find what to work on, then catch_up or read it.",
      inputSchema: { query: z.string().optional().describe("Optional title search filter.") },
    },
    async ({ query }) => {
      // viewerId keeps private rows scoped to the agent's human (mirrors `own`) —
      // the owner row written at publish is what lets the agent always find its
      // own drafts while a teammate's private work stays invisible.
      const arts = await ctx.meta.listArtifacts({
        orgId: org,
        q: query,
        viewerId: actingFor?.id ?? agent.id,
      })
      return json({ count: arts.length, artifacts: arts.map(summarizeArtifact) })
    },
  )

  // READ CONTENT --------------------------------------------------------------
  server.registerTool(
    "read",
    {
      description:
        "Read an artifact's CONTENT by short id. Multi-page bundle: omit `section` to get its outline (the list of pages), then call again with a `section` (a page path) for that page's full text. Single-file artifact: returns the full content. Pass a past `version` to read history. (For what CHANGED, or the comment threads, use catch_up.)",
      inputSchema: {
        short_id: z.string().describe("The artifact's short id, e.g. nk0dsral."),
        section: z
          .string()
          .optional()
          .describe("A bundle page path, e.g. agentic-loop.html. Omit to get the outline first."),
        version: z.number().optional().describe("Defaults to the current version."),
      },
    },
    async ({ short_id, section, version }) => {
      const a = await own(short_id)
      if (!a) return notFound(short_id)
      const n = version ?? a.current_version
      if (n < 1 || n > a.current_version)
        return err(`No version ${n} for "${short_id}" — it has versions 1..${a.current_version}.`)
      const v = await ctx.meta.getVersion(a.id, n)
      if (!v) return err(`Version ${n} of "${short_id}" is unavailable.`)
      const manifest = await manifestOf(ctx, v)
      if (!manifest) {
        // Single-file artifact — return its content.
        const body = await ctx.sourceText(v)
        return json({
          short_id,
          title: a.title,
          kind: a.kind,
          version: n,
          content: clip(body ?? ""),
        })
      }
      const pages = Object.keys(manifest.files).map(cleanPath)
      if (!section)
        return json({
          short_id,
          title: a.title,
          kind: "bundle",
          version: n,
          entry: cleanPath(manifest.entry),
          pages,
          next: "Call read again with a `section` (one of the pages above) for that page's content.",
        })
      const file = manifest.files[section] ?? manifest.files[`/${cleanPath(section)}`]
      if (!file) return err(`No page "${section}" in "${short_id}". Pages: ${pages.join(", ")}.`)
      const bytes = await ctx.blobs.get(file.key)
      return json({
        short_id,
        version: n,
        section: cleanPath(section),
        type: file.type,
        content: clip(bytes ? new TextDecoder().decode(bytes) : ""),
      })
    },
  )

  // CATCH UP — state, feedback, history, and diffs all in one ------------------
  server.registerTool(
    "catch_up",
    {
      description:
        "START HERE on an artifact. The state of it in one call: a one-line summary, the versions that landed since `since_version`, which pages changed, the open (and outdated) comment threads, and the full version history. " +
        "Pass `comments` (open / addressed / resolved / outdated) to instead get that filtered thread list — your feedback to-do queue. " +
        "Pass `response_format='detailed'` (optionally with `since_version`/`to_version`) to include the exact line-by-line diff between two versions. " +
        "WAITING ON A REVIEW? Pass `wait` (seconds, max 50): the call blocks until the human sends back / approves / comments (or the time runs out), then returns the fresh state. Chain wait calls instead of sleeping between polls — feedback reaches you in seconds.",
      inputSchema: {
        short_id: z.string(),
        since_version: z
          .number()
          .optional()
          .describe("The version you last saw (the diff base). Defaults to to_version − 1."),
        to_version: z
          .number()
          .optional()
          .describe("Compare up to this version instead of the current one (for an exact diff)."),
        comments: z
          .enum(["open", "addressed", "resolved", "outdated"])
          .optional()
          .describe(
            "Return ONLY this state's comment threads (the feedback queue) instead of the delta.",
          ),
        response_format: z
          .enum(["summary", "detailed"])
          .optional()
          .describe(
            "'summary' (default, token-light) omits the line diff; 'detailed' includes it.",
          ),
        wait: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe(
            "Long-poll: block up to this many seconds for the human's next action (send back, approve, or a new comment) before returning. Returns immediately when something is already actionable.",
          ),
      },
    },
    async ({ short_id, since_version, to_version, comments, response_format, wait }) => {
      let a = await own(short_id)
      if (!a) return notFound(short_id)

      // Long-poll: when the agent is waiting on the human, block on the artifact
      // channel until they act, then fall through and build the response fresh
      // (composes with the `comments` filter below — wait, then the queue). The
      // event is only a wake signal — all state below is re-read from the store,
      // so a missed or raced event can never produce a wrong answer. The
      // subscription starts BEFORE the state check, so an action landing in that
      // gap wakes us instead of slipping through; when something is already
      // actionable the wait is released immediately.
      if (wait && ctx.bus.waitFor) {
        const release = new AbortController()
        const waited = ctx.bus
          .waitFor(
            a.id,
            [
              "review.sent_back",
              "review.approved",
              "comment.created",
              "comment.updated",
              "version.published",
            ],
            wait * 1000,
            release.signal,
          )
          .catch(() => null)
        const rounds = await ctx.meta.listReviewRounds(a.id)
        const round =
          rounds.find((r) => r.state === "pending") ??
          rounds.find((r) => r.requested_by === agent.id) ??
          rounds[0] ??
          null
        // Actionable = a settled decision the agent hasn't built on yet (it still
        // applies to the current head). A stale sent_back/approved from an older
        // version never disables the long-poll — the agent already consumed it.
        const actionable = round && round.state !== "pending" && round.version >= a.current_version
        if (actionable) {
          release.abort()
          await waited
        } else {
          await waited
          // Refresh: the head (or the artifact itself) may have moved while waiting.
          a = (await own(short_id)) ?? a
        }
      }

      // `comments` filter → the feedback to-do queue (absorbs the old list_comments).
      if (comments) {
        const list = await ctx.meta.listComments(a.id, { state: comments })
        return json({
          short_id,
          comments_state: comments,
          count: list.length,
          comments: list.map(summarizeComment),
        })
      }

      const head = a.current_version
      const to = Math.min(head, Math.max(1, to_version ?? head))
      const since = Math.min(to, Math.max(1, since_version ?? to - 1))
      const history = await ctx.meta.listVersions(a.id)
      const newVersions = history.filter((v) => v.n > since && v.n <= to)
      const vs = await ctx.meta.getVersion(a.id, since)
      const vh = await ctx.meta.getVersion(a.id, to)
      let entryDiff: string | null = null
      let pagesChanged: ReturnType<typeof bundleFileChanges> | null = null
      if (vs && vh && since < to) {
        const [ms, mh] = [await manifestOf(ctx, vs), await manifestOf(ctx, vh)]
        if (ms && mh) pagesChanged = bundleFileChanges(ms, mh)
        if (response_format === "detailed") {
          const [as_, ah] = [await ctx.sourceText(vs), await ctx.sourceText(vh)]
          if (as_ !== null && ah !== null) entryDiff = clip(formatDiff(diffLines(as_, ah)))
        }
      }
      const open = await ctx.meta.listComments(a.id, { state: "open" })
      // Threads whose quoted text changed in a landed version — feedback that may no
      // longer apply. Surfacing it tells the agent its edits touched commented text.
      const outdated = await ctx.meta.listComments(a.id, { state: "outdated" })
      const outdatedBit = outdated.length
        ? ` ${outdated.length} now outdated (the quoted text changed).`
        : ""
      // Threads with a proposal already pending — the agent shouldn't re-address them.
      const addressed = await ctx.meta.listComments(a.id, { state: "addressed" })
      const addressedBit = addressed.length
        ? ` ${addressed.length} addressed (a proposal is pending review).`
        : ""
      const pageBits =
        pagesChanged && changeCount(pagesChanged)
          ? ` Pages: ${[
              pagesChanged.added.length && `+${pagesChanged.added.length}`,
              pagesChanged.changed.length && `~${pagesChanged.changed.length}`,
              pagesChanged.removed.length && `-${pagesChanged.removed.length}`,
            ]
              .filter(Boolean)
              .join(" ")}.`
          : ""
      // The review round this agent is waiting on (the loop's poll target): the round
      // it requested most recently. `pending` = still waiting; `sent_back` = the human
      // returned answers — read the open threads and revise; `approved` = the go-signal.
      const rounds = await ctx.meta.listReviewRounds(a.id)
      const myRound =
        rounds.find((r) => r.state === "pending") ??
        rounds.find((r) => r.requested_by === agent.id) ??
        rounds[0] ??
        null
      const review = myRound
        ? {
            state: myRound.state,
            version: myRound.version,
            requested_at: myRound.created_at,
            resolved_at: myRound.resolved_at,
            note: myRound.note,
          }
        : null
      const reviewBit = review
        ? review.state === "pending"
          ? ` Review requested on v${review.version} — waiting for the human.`
          : review.state === "sent_back"
            ? ` The human sent back their review of v${review.version} — read the open threads, revise, and re-request.`
            : ` The human approved v${review.version} — you're clear to proceed.`
        : ""
      const summary =
        since >= to
          ? `You're up to date on "${a.title}" (v${head}); ${open.length} open comment${open.length === 1 ? "" : "s"}.${addressedBit}${outdatedBit}${reviewBit}`
          : `"${a.title}": ${newVersions.length} new version${newVersions.length === 1 ? "" : "s"} since v${since} (now v${to}).${pageBits} ${open.length} open comment${open.length === 1 ? "" : "s"}.${addressedBit}${outdatedBit}${reviewBit}`
      return json({
        summary,
        review,
        short_id,
        since,
        to,
        head,
        caught_up: since >= to,
        versions: history.slice().reverse().map(summarizeVersion),
        new_versions: newVersions.map(summarizeVersion),
        pages_changed: pagesChanged,
        ...(entryDiff
          ? { entry_diff: entryDiff }
          : {
              entry_diff:
                "(omitted) — call again with response_format='detailed' for the line-level changes.",
            }),
        open_comments: open.map(summarizeComment),
        ...(outdated.length ? { outdated_comments: outdated.map(summarizeComment) } : {}),
      })
    },
  )

  // COMMENT — leave / reply / resolve feedback --------------------------------
  server.registerTool(
    "comment",
    {
      description:
        "Leave feedback on an artifact, reply in a thread, react, and/or resolve or reopen a thread — all in one tool. Anchor a NEW comment to a quoted span of the rendered text with `quote`. Reply by passing the thread id as `reply_to`. Pass `react` (with `reply_to`) to acknowledge the latest human comment in a thread without the noise of a reply — the minimum ack the loop requires. Resolve or reopen by passing `set_state` along with the thread's id in `reply_to`. Thread ids come from catch_up.",
      inputSchema: {
        short_id: z.string(),
        body: z
          .string()
          .optional()
          .describe("The comment text (Markdown). Omit when just reacting or changing state."),
        reply_to: z
          .string()
          .optional()
          .describe(
            "A thread id (from catch_up): reply in that thread, and/or the thread to react / set_state on.",
          ),
        quote: z
          .string()
          .optional()
          .describe("Exact text in the rendered document to anchor a NEW comment to."),
        react: z
          .enum(REACTIONS as [string, ...string[]])
          .optional()
          .describe(
            "React to the thread's latest comment by someone else (with `reply_to`) — the lightweight ack. 👍 is the loop's default.",
          ),
        set_state: z
          .enum(["resolved", "open"])
          .optional()
          .describe("Resolve the thread, or reopen it (with `reply_to`)."),
      },
    },
    async ({ short_id, body, reply_to, quote, react, set_state }) => {
      const a = await own(short_id)
      if (!a) return notFound(short_id)
      if (!roleAllows(agent.role, "comment"))
        return err(
          "Your grant is read-only (derive:read). Re-authorize the connector with derive:comment to leave feedback.",
        )
      if (!body && !set_state && !react)
        return err(
          "Provide `body` (to comment), `react` (to acknowledge), or `set_state` (to resolve/reopen).",
        )
      let thread = reply_to
      let commentId: string | undefined
      if (body) {
        commentId = newId("c")
        thread = reply_to || commentId
        const anchor = quote ? JSON.stringify({ type: "TextQuoteSelector", exact: quote }) : null
        await ctx.meta.createComment({
          id: commentId,
          artifact_id: a.id,
          thread_id: thread,
          base_version: a.current_version,
          path: null,
          anchor,
          body_md: body,
          author: agent.name,
          author_id: agent.id,
        })
        ctx.bus.publish(a.id, { type: "comment.created" })
      }
      // The ack: land the emoji on the thread's newest comment by someone ELSE
      // (the human being acknowledged), falling back to its newest comment.
      // Idempotent — re-acking never toggles the reaction off.
      let reactedTo: string | undefined
      if (react) {
        if (!thread) return err("`react` needs `reply_to` (the thread to acknowledge).")
        const inThread = (await ctx.meta.listComments(a.id)).filter(
          (c) => c.thread_id === thread && !parseMeta(c.meta).deleted,
        )
        if (inThread.length === 0) return err(`No thread "${thread}" on "${short_id}".`)
        const target =
          [...inThread].reverse().find((c) => c.author_id !== agent.id) ??
          inThread[inThread.length - 1]
        if (target) {
          const md = parseMeta(target.meta)
          const reactions = md.reactions ?? {}
          const arr = reactions[react] ?? []
          if (!arr.includes(agent.name)) arr.push(agent.name)
          reactions[react] = arr
          md.reactions = reactions
          await ctx.meta.updateComment(target.id, { meta: JSON.stringify(md) })
          ctx.bus.publish(a.id, { type: "comment.reacted", thread_id: thread })
          reactedTo = target.id
        }
      }
      if (set_state) {
        if (!thread) return err("`set_state` needs `reply_to` (the thread id to resolve/reopen).")
        await ctx.meta.setThreadState(a.id, thread, set_state)
        ctx.bus.publish(a.id, { type: "comment.resolved", thread_id: thread, state: set_state })
      }
      return json({
        short_id,
        thread,
        ...(commentId ? { comment_id: commentId, anchored_to: quote ?? null } : {}),
        ...(reactedTo ? { reacted: react, reacted_to: reactedTo } : {}),
        ...(set_state ? { state: set_state } : {}),
        note: body
          ? reply_to
            ? "Replied in the thread."
            : "New comment thread created."
          : reactedTo
            ? `Acknowledged with ${react}.`
            : `Thread ${set_state}.`,
      })
    },
  )

  // WRITE — publish live, or file a proposal for review -----------------------
  server.registerTool(
    "publish",
    {
      description:
        "Save a revision of an artifact. It goes LIVE immediately if your role can publish (Creator/Admin); otherwise — or whenever you pass for_review:true — it is filed as a PROPOSAL a human approves before it goes live. Provide `content` for a SINGLE-FILE artifact, or `files` (a map of page path → content) for a MULTI-PAGE BUNDLE (a whole site, images and any binary asset). OMIT short_id to create a NEW artifact (`title` required); PASS short_id to add a version to one you own, matching its kind. A bundle republish REPLACES the whole bundle, so include EVERY page and asset (or use `merge`). Pass `addresses` with the thread ids (from catch_up) this revision resolves. Provide the FULL content, not a patch. (Proposals are single-file only; bundles must be published directly.)",
      inputSchema: {
        content: z
          .string()
          .optional()
          .describe(
            "The complete content for a SINGLE-FILE artifact (HTML or Markdown). Use this OR `files`, not both.",
          ),
        files: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'A MULTI-PAGE bundle as a map of path → content — the whole site. Each value is one of: a text page (plain string); a base64 data: URI for a small inline binary ("shot.png":"data:image/png;base64,iVBORw0K…"); or — PREFERRED for real images — an "asset:<hash>" handle returned by uploading the raw bytes to POST /v1/assets first ("shot.png":"asset:9f86d0818…"). The asset handle keeps the call tiny: stream each screenshot up as raw binary (no base64 transcription), then reference the handles here. Example: {"index.html":"<img src=shot.png>","styles.css":"…","shot.png":"asset:9f86d0818…","logo.png":"data:image/png;base64,iVBORw0K…"}. The root index.html (else the shallowest .html) becomes the entry page; pages reference assets by relative path. Served content-type comes from the file extension, so give binary entries a real extension (.png/.jpg/.webp/.woff2). A plain republish REPLACES the bundle (include every page and asset). Keep each call to a few MB; for many/large images, upload them to /v1/assets and reference the handles (or publish pages first, then `merge` asset batches).',
          ),
        title: z
          .string()
          .optional()
          .describe(
            "Title for a NEW artifact (required when creating). On republish, renames only if provided.",
          ),
        short_id: z
          .string()
          .optional()
          .describe("Omit to create a new artifact; pass it to revise one you own."),
        visibility: z
          .enum(["private", "workspace", "public"])
          .optional()
          .describe(
            "Who can open a NEW artifact: private (the human you act for + people they add — the usual default for agent publishes; they promote it when ready), workspace (their team), or public (the link works for anyone). Omit to use the workspace's agent default. Ignored on republish — the human promotes via the share dialog.",
          ),
        spa: z
          .boolean()
          .optional()
          .describe(
            "For a NEW bundle only: serve unknown paths from the entry page (single-page-app routing). Default false.",
          ),
        merge: z
          .boolean()
          .optional()
          .describe(
            "Add/overwrite the given `files` INTO the existing bundle instead of replacing it (default false). Build a large site across several calls without re-sending it: publish the pages first, then merge in batches of assets — each call carries only the new files. Requires `short_id` of a bundle; same-path files overwrite, the rest are kept.",
          ),
        message: z.string().optional().describe("What changed — recorded as the version message."),
        filename: z
          .string()
          .optional()
          .describe(
            "Filename hint for the content type of a single file, e.g. index.html or notes.md.",
          ),
        for_review: z
          .boolean()
          .optional()
          .describe(
            "File this as a PROPOSAL for a human to approve instead of publishing live (single-file only). Forced on when your role can't publish directly.",
          ),
        addresses: z
          .array(z.string())
          .optional()
          .describe(
            "Thread ids (from catch_up) this revision resolves. On a live publish they resolve; on a proposal they flip to `addressed` and resolve on approval.",
          ),
        request_review: z
          .boolean()
          .optional()
          .describe(
            "After a LIVE publish, open a review round asking your human to review this version — the /derive loop. They answer inline and hit Send back (or Approve); poll catch_up's `review` for the state. No effect on a proposal (that already IS a review).",
          ),
      },
    },
    async ({
      content,
      files,
      title,
      short_id,
      visibility,
      spa,
      merge,
      message,
      filename,
      for_review,
      addresses,
      request_review,
    }) => {
      const existing = short_id ? await own(short_id) : null
      if (short_id && !existing) return text(`No artifact "${short_id}" in this workspace.`)
      // Exactly one of content / files. `files` (a page map) means a bundle.
      const isBundle = !!files && Object.keys(files).length > 0
      if (isBundle && content !== undefined)
        return text("Provide `content` (single file) OR `files` (a bundle), not both.")
      if (!isBundle && (content === undefined || content === ""))
        return text("Provide `content` (single file) or `files` (a multi-page bundle).")
      if (existing) {
        // Kind can't change on republish; steer to the right field instead of the 409.
        if (existing.kind === "bundle" && !isBundle)
          return text(
            `"${short_id}" is a multi-page bundle — pass \`files\` (every page) to republish it.`,
          )
        if (existing.kind === "file" && isBundle)
          return text(`"${short_id}" is a single-file artifact — pass \`content\`, not \`files\`.`)
      }

      // Direct publish is gated on the agent's role (Creator/Admin). A commenter-level
      // grant — or anyone asking for_review — is routed to a human-reviewed proposal,
      // so a low-privilege agent still can't push live content.
      const review = for_review === true || !roleAllows(agent.role, "publish")
      if (review) {
        if (!roleAllows(agent.role, "propose"))
          return text(
            "Your grant is read-only (derive:read). Re-authorize with derive:propose (or a publish scope) to suggest changes.",
          )
        if (isBundle)
          return text(
            "Multi-page bundles can't be proposed for review yet — only published directly. Ask an editor to publish, or submit a single-file `content` revision.",
          )
        if (!existing)
          return text(
            "A proposal revises an EXISTING artifact — pass its `short_id`. Creating a new artifact needs publish rights (a Creator/Admin grant).",
          )
        try {
          const { proposal } = await proposeChange(ctx.meta, ctx.blobs, short_id as string, {
            bytes: new TextEncoder().encode(content as string),
            filename: filename ?? "index.html",
            isBundle: false,
            message: message ?? "Proposed revision",
            author: agent.name,
            author_id: agent.id,
            // Delegation provenance: the agent proposes on behalf of the human that
            // authorized it, so reviewers see "Agent X on behalf of Alice."
            on_behalf_of: actingFor?.id ?? null,
          })
          const addressed = addresses?.length
            ? await markAddressed(ctx.meta, existing.id, proposal.id, addresses)
            : []
          for (const threadId of addressed)
            ctx.bus.publish(existing.id, {
              type: "comment.addressed",
              thread_id: threadId,
              state: "addressed",
            })
          return json({
            published: false,
            proposed: true,
            proposal_id: proposal.id,
            base_version: proposal.base_version,
            addressed,
            note: "Submitted for review — a human approves it or requests changes. It is NOT live yet.",
          })
        } catch (e) {
          return text(
            `Couldn't store the proposal: ${e instanceof PublishError ? e.message : "unknown error"}.`,
          )
        }
      }

      // Live publish path.
      if (merge) {
        if (!isBundle) return text("`merge` adds files to a bundle — pass `files`, not `content`.")
        if (!existing) return text("`merge` needs the `short_id` of an existing bundle to add to.")
        if (existing.kind !== "bundle")
          return text(
            `"${short_id}" is a single-file artifact — \`merge\` only applies to bundles.`,
          )
      }
      if (!existing && !title?.trim()) return text("Creating a new artifact needs a `title`.")
      try {
        let bytes: Uint8Array
        // A merge keeps the bundle's existing SPA routing (the caller isn't redeclaring it).
        let bundleSpa = isBundle ? !!spa : undefined
        if (!isBundle) {
          bytes = new TextEncoder().encode(content as string)
        } else if (merge && existing) {
          const v = await ctx.meta.getVersion(existing.id, existing.current_version)
          const manifest = v && (await manifestOf(ctx, v))
          if (!manifest)
            return text(`Couldn't read the current bundle for "${short_id}" to merge into.`)
          bytes = await mergeBundleZip(ctx.blobs, manifest, files as Record<string, string>)
          bundleSpa = manifest.spa
        } else {
          bytes = await zipBundleFiles(files as Record<string, string>, ctx.blobs)
        }
        // The workspace decides where an agent's NEW artifact lands when the
        // agent doesn't say — unlisted by default: out of the team library, one
        // link away for the human. Sharing wider stays a deliberate human act.
        const settings = short_id ? null : await ctx.meta.getOrgSettings(org)
        const { artifact, version } = await publishVersion(
          ctx.meta,
          ctx.blobs,
          {
            bytes,
            filename: isBundle ? `${title?.trim() || "bundle"}.zip` : (filename ?? "index.html"),
            isBundle,
            spa: bundleSpa,
            title: title?.trim(),
            message,
            author: agent.name,
            // Attributed to the human the agent acts for — their profile, their
            // followers' feed (same as the HTTP publish route).
            authorId: actingFor?.id ?? null,
            // New artifacts land in the granting user's workspace, never wider
            // than asked (the workspace's agent default when unspecified).
            orgId: agent.org_id,
            visibility:
              visibility === "public"
                ? "public"
                : visibility === "workspace"
                  ? "org"
                  : visibility === "private"
                    ? "private"
                    : (settings?.defaultAgentVisibility ?? "private"),
          },
          short_id,
        )
        // Ownership, same as the HTTP route: one row, the human the agent acts
        // for (the agent borrows that standing — no agent rows in the roster).
        if (!short_id)
          await ctx.meta.setArtifactMember({
            id: newId("am"),
            artifact_id: artifact.id,
            user_id: actingFor?.id ?? agent.id,
            role: "owner",
          })
        // Event parity with the HTTP publish route: the artifact channel makes a
        // tab viewing this doc live-reload; the webhook outbox fans out to
        // integrations. Without these an MCP publish is invisible to open tabs.
        ctx.bus.publish(artifact.id, {
          type: "version.published",
          n: version.n,
          message: version.message,
        })
        await ctx.notify(artifact, "version.published", {
          version: version.n,
          message: version.message,
          author: version.author,
        })
        // Re-anchor existing threads: feedback whose quoted text changed flips to
        // `outdated` (and back to `open` if the text reappears). Same sweep the
        // HTTP route runs — MCP publish must call it too.
        await publishSweepEvents(ctx.meta, ctx.blobs, ctx.bus, artifact.id, version)
        // A live publish that fixes feedback resolves those threads directly (no
        // approval step to wait on, unlike a proposal's `addressed`).
        const resolved: string[] = []
        for (const threadId of addresses ?? []) {
          await ctx.meta.setThreadState(artifact.id, threadId, "resolved")
          ctx.bus.publish(artifact.id, {
            type: "comment.resolved",
            thread_id: threadId,
            state: "resolved",
          })
          resolved.push(threadId)
        }
        // The /derive loop: ask the human to review this live version.
        let review_round: string | null = null
        if (request_review && actingFor) {
          const round = await ctx.meta.createReviewRound({
            id: newId("rr"),
            artifact_id: artifact.id,
            version: version.n,
            requested_by: agent.id,
            requested_for: actingFor.id,
          })
          review_round = round.id
          ctx.bus.publish(artifact.id, { type: "review.requested", round_id: round.id })
          await ctx.notify(artifact, "review.requested", {
            version: version.n,
            requested_by: agent.name,
          })
          // The review request is the one event that earns an email: the loop is
          // blocked on the human, who may have no tab open (same policy as the
          // HTTP publish path). `settings` is only pre-loaded on a create, so a
          // republish (where most review rounds happen) fetches the gate here.
          if ((settings ?? (await ctx.meta.getOrgSettings(org))).emailNotifications) {
            const [r] = await ctx.meta.getUsers([actingFor.id])
            if (r?.email)
              await enqueueChannelDelivery(ctx.meta, "email", "review.requested", {
                to: r.email,
                toName: r.name ?? undefined,
                ...buildReviewEmail(ctx.deps.baseUrl, artifact, {
                  requestedBy: agent.name,
                  version: version.n,
                }),
              })
          }
        }
        const url = artifactUrl(ctx.deps.baseUrl, artifact)
        // Bell entry for the human behind the grant, so a push reaches them even
        // with no tab open (the on-the-go path). One row per push that warrants
        // one: a review ask beats a plain "published" (never both).
        if (actingFor && (review_round || !short_id)) {
          const row = {
            id: newId("n"),
            user_id: actingFor.id,
            actor: agent.name,
            kind: review_round ? ("review" as const) : ("publish" as const),
            artifact_id: artifact.id,
            artifact_short_id: artifact.short_id,
            artifact_title: artifact.title,
            thread_id: "",
            comment_id: "",
            preview: review_round
              ? `requested your review of v${version.n}`
              : (artifact.title ?? "published something new"),
          }
          await ctx.meta.createNotification(row)
          ctx.bus.publish(`u:${actingFor.id}`, {
            type: "notification",
            notification: { ...row, read: 0, created_at: new Date().toISOString() },
          })
        }
        // Auto-open: tell the granting user's open tabs an agent just pushed. The
        // delivery receipt (how many live streams caught it) becomes
        // `opened_in_tab`, so the agent knows whether to open the URL locally.
        let openedInTab = false
        if (actingFor) {
          const channel = `u:${actingFor.id}`
          const pushed = {
            type: "artifact.pushed" as const,
            event_id: newId("ev"),
            short_id: artifact.short_id,
            artifact_id: artifact.id,
            title: artifact.title,
            version: version.n,
            kind: short_id ? "revised" : "created",
            url,
            agent: agent.name,
            review_requested: !!review_round,
          }
          if (ctx.bus.publishWithReceipt) {
            openedInTab =
              (await withTimeout(ctx.bus.publishWithReceipt(channel, pushed), 1500, 0)) > 0
          } else {
            ctx.bus.publish(channel, pushed)
          }
        }
        return json({
          published: true,
          short_id: artifact.short_id,
          ...(review_round ? { review_requested: true } : {}),
          kind: artifact.kind,
          version: version.n,
          url,
          title: artifact.title,
          visibility: artifact.visibility,
          ...(resolved.length ? { resolved } : {}),
          ...(actingFor ? { opened_in_tab: openedInTab } : {}),
          note:
            (merge
              ? `Live now — merged ${Object.keys(files as Record<string, string>).length} file(s) into the bundle (new current version).`
              : short_id
                ? "Live now — published a new current version."
                : "Live now — created a new artifact in your workspace.") +
            (actingFor && !openedInTab
              ? " No open Derive tab caught this push — open the url for the user (e.g. run `open <url>`) if they should see it now."
              : ""),
        })
      } catch (e) {
        const msg = e instanceof PublishError ? e.message : "could not publish"
        return text(`Publish failed: ${msg}`)
      }
    },
  )

  return server
}

/**
 * Mount the Streamable-HTTP MCP endpoint at /mcp, bearer-gated by the same agent
 * bridge the rest of the API uses. On a missing/invalid token we return the
 * spec-required 401 + WWW-Authenticate pointing at our protected-resource metadata,
 * which is how claude.ai auto-starts the OAuth handshake.
 */
export function mountMcp(app: Hono, ctx: AppContext): void {
  app.all("/mcp", async (c) => {
    const agent = await ctx.agentFor(c)
    if (!agent) {
      const meta = new URL("/.well-known/oauth-protected-resource", c.req.url).toString()
      return c.json(
        { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } },
        401,
        { "WWW-Authenticate": `Bearer resource_metadata="${meta}"` },
      )
    }
    const ownerId = await ctx.privateOwnerId(c)
    const actingFor = ownerId ? ((await ctx.meta.getUsers([ownerId]))[0] ?? null) : null
    const server = buildServer(ctx, agent, actingFor)
    const transport = new StreamableHTTPTransport()
    await server.connect(transport)
    return transport.handleRequest(c)
  })
}

import { artifactUrl, roleAllows } from "@derive/core"
import { z } from "zod"
import { parseMeta } from "../lib/comments"
import { signRawToken } from "../lib/crypto"
import { RAW_TOKEN_MAX_AGE_MS } from "../lib/http"
import { isWebOrigin } from "../lib/serve-content"
import { ARTIFACT_VIEW_URI } from "../mcp-app-view"
import type { ToolContext } from "../mcp-tool-context"
import { err, historyNotPublic, versionOpenToWorld } from "../mcp-util"

/**
 * SHOW an artifact to the person, inside the conversation. A separate tool from `read`
 * because MCP Apps binds a view to a TOOL (`_meta.ui.resourceUri`), not to a result: a
 * host that renders apps opens the view on every call, so riding `read` would put a card
 * on every outline and grep. Read-only, like `read`; a host without apps gets the text and
 * the link, which is the whole of what this tool promises there.
 *
 * The view frames Derive's own sandboxed viewer (`/raw/.../t/<token>/`), the same page and
 * the same deck protocol the web app drives. The token is the existing raw capability: one
 * artifact, minutes long, minted for a caller `reach` already authorized. It rides in the
 * result's `_meta`, which a host hands to the view and not to the model. The view calls
 * this tool again for a fresh one, so the tool is visible to the app as well as the model.
 */
export function registerShowTool(tc: ToolContext): void {
  const { server, ctx, reach, notFound, wsArg, num } = tc
  server.registerTool(
    "show",
    {
      description:
        "Show an artifact to the person here as a live view they can navigate and select in. Hosts without apps get its link.",
      annotations: {
        title: "Show an artifact",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        short_id: z.string(),
        version: num("version", { int: true, min: 1 }).optional().describe("Default current."),
        slide: num("slide", { int: true, min: 1 }).optional().describe("Deck: open on this slide."),
        editor: z.string().optional().describe("Set by the view; omit."),
        thread: z.string().optional().describe("A question thread to ask."),
        workspace: wsArg,
      },
      // The MCP Apps key only. ChatGPT's legacy `openai/outputTemplate` alias names a
      // text/html+skybridge resource, which this view is not.
      _meta: { ui: { resourceUri: ARTIFACT_VIEW_URI } },
    },
    async ({ short_id, version, slide, editor, thread, workspace }) => {
      const r = await reach(short_id, workspace, { public: true })
      if (r && "error" in r) return err(r.error)
      if (!r) return notFound(short_id)
      const a = r.a
      const n = version ?? a.current_version
      if (n < 1 || n > a.current_version)
        return err(`No version ${n} for "${short_id}" — it has versions 1..${a.current_version}.`)
      if (r.public && !versionOpenToWorld(a, n)) return historyNotPublic(short_id, a)
      const url = artifactUrl(ctx.deps.baseUrl, a)
      const title = a.title ?? a.short_id
      // Editing in the view saves through `publish`, so it is offered exactly where a
      // publish would succeed: a seat that may publish, never the world link.
      const canEdit = !r.public && roleAllows(r.role, "publish")
      // The view asks for an editable frame by naming its own origin. That origin may then
      // drive the inline editor on THIS caller's page (unstamped: it collects quote edits,
      // which `publish` resolves). The token is the secret; the origin only scopes it.
      const host = canEdit && editor && isWebOrigin(editor) ? editor : undefined
      const raw = signRawToken(ctx.deps.encryptionKey ?? "", {
        rid: a.id,
        // A seat reaches the history it can read anyway; the world link reaches only what
        // the artifact made public. The version check above already refused the rest.
        history: !r.public || !!a.public_history,
        ...(host ? { host } : {}),
      })
      const rawBase = ctx.deps.sandboxOrigin ?? ctx.deps.baseUrl
      // A question (comment({options})) asked in the view: its words, its choices, and the
      // first reply if someone already answered. Read with the same reach as the page.
      let question: Record<string, unknown> | null = null
      if (thread) {
        const inThread = (await ctx.meta.listComments(a.id, { threadId: thread })).filter(
          (c) => !parseMeta(c.meta).deleted,
        )
        const root = inThread.find((c) => c.id === thread) ?? inThread[0]
        const asked = root
          ? (parseMeta(root.meta) as { question?: { options?: unknown } }).question
          : undefined
        if (!root || !asked) return err(`No question thread "${thread}" on "${short_id}".`)
        const reply = inThread.find((c) => c.id !== root.id)
        question = {
          thread,
          text: root.body_md,
          options: Array.isArray(asked.options)
            ? asked.options.filter((o) => typeof o === "string")
            : [],
          answer: reply ? reply.body_md : null,
          can_answer: !r.public && roleAllows(r.role, "comment"),
        }
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Showing "${title}" v${n}${slide ? ` at slide ${slide}` : ""} to the person: ${url}. When they select a slide or section, it arrives as context; act on that version.`,
          },
        ],
        structuredContent: {
          short_id: a.short_id,
          title,
          version: n,
          current_version: a.current_version,
          // 1-based, as the person counts; the view opens a deck there once it reports in.
          slide: slide ?? null,
          can_edit: canEdit,
          editing: !!host,
          question,
          url,
          workspace: r.org,
        },
        _meta: {
          "derive/frame": {
            url: `${rawBase}/raw/${a.short_id}/v/${n}/t/${raw.token}/`,
            expires_at: new Date(raw.issuedAt + RAW_TOKEN_MAX_AGE_MS).toISOString(),
          },
        },
      }
    },
  )
}

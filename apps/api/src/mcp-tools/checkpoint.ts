import {
  artifactUrl,
  newId,
  newShortId,
  PublishError,
  publish as publishVersion,
  roleAllows,
} from "@derive/core"
import { z } from "zod"
import { afterPublish } from "../lib/after-publish"
import type { ToolContext } from "../mcp-tool-context"
import { json, text } from "../mcp-util"

// CHECKPOINT -----------------------------------------------------------------
// Commit a one-page LAYER of working state to a lineage artifact, so a later
// session — anyone's, on any machine — continues the work cold. Deliberately a
// thin composition over the same live-publish path as `publish`: each checkpoint
// REPLACES the page (artifact versions are the layer history, pinned by name),
// and the content itself carries the paste-able resume command, so it travels
// everywhere the artifact does (page, read tool, Slack unfurl) with no bespoke
// UI. The first version can name its own id because create pre-mints it.
const LINEAGE_MARKER = "<!-- derive:lineage -->"
const MAX_LAYER_CHARS = 8000
// Agent-supplied text must not counterfeit the template's own affordances:
// collapse code-fence runs (a smuggled fenced block renders with the copy
// affordance humans are trained to paste from the real resume block) and
// escape heading lines (a forged "## Continue from here" section). The write
// capability isn't new — `publish` accepts arbitrary content — but this
// template frames its page as tool-authored, so the body can't fake the frame.
const cleanField = (s: string): string =>
  s
    .replace(/[`~]{3,}/g, "``")
    .split("\n")
    .map((l) => l.replace(/^(\s*)(#{1,6}\s)/, "$1\\$2"))
    .join("\n")
const layerSection = (heading: string, items?: string[]): string => {
  const kept = (items ?? []).map((i) => cleanField(i.trim())).filter(Boolean)
  return kept.length ? `\n## ${heading}\n\n${kept.map((i) => `- ${i}`).join("\n")}\n` : ""
}

export function registerCheckpointTool(tc: ToolContext): void {
  const { server, ctx, agent, actingFor, defaultOrg, defaultRole, reach, resolveWs, wsArg } = tc

  server.registerTool(
    "checkpoint",
    {
      description:
        "Commit a compact LAYER of working state to this work's lineage — a one-page, human-readable checkpoint (state / decisions / open threads / next steps / refs) that lets ANY later session continue the work cold, on any machine. Call it at task boundaries: a task just completed, before a risky step, when wrapping up a session. FIRST call for a piece of work: pass `work` (a short name); the result names a short_id — record it (e.g. in a .derive/lineage file) and pass it as `short_id` on every checkpoint after. Each checkpoint REPLACES the page (versions keep the history), so restate what still matters and prefer refs over restated detail — the tool rejects more than a page. See derive://skills/checkpoint.",
      inputSchema: {
        work: z
          .string()
          .optional()
          .describe(
            "Short name for the work (becomes the lineage's title), e.g. the feature or branch name. Required on the FIRST checkpoint; ignored after.",
          ),
        short_id: z
          .string()
          .optional()
          .describe("The lineage to update — the short_id a previous checkpoint returned."),
        state: z
          .string()
          .describe("Where the work stands right now, a few plain sentences — the cold open."),
        decisions: z
          .array(z.string())
          .optional()
          .describe("Decisions currently in force, each with its why — including rejected paths."),
        open: z
          .array(z.string())
          .optional()
          .describe("Unresolved questions or threads a continuing session must not drop."),
        next: z.array(z.string()).optional().describe("Concrete next steps, most immediate first."),
        refs: z
          .array(z.string())
          .optional()
          .describe(
            "Pointers a continuing session should follow — artifact short_ids, PR/issue URLs, key file paths.",
          ),
        workspace: wsArg,
      },
    },
    async ({ work, short_id, state, decisions, open, next, refs, workspace }) => {
      const reached = short_id ? await reach(short_id, workspace) : null
      if (reached && "error" in reached) return text(reached.error)
      const existing = reached && !("error" in reached) ? reached.a : null
      if (short_id && !existing) return text(`No artifact "${short_id}" you can reach.`)
      let targetOrg = defaultOrg
      let actRole = defaultRole
      if (existing && reached && !("error" in reached)) {
        targetOrg = reached.org
        actRole = reached.role
      } else if (!short_id) {
        const t = await resolveWs(workspace)
        if ("error" in t) return text(t.error)
        targetOrg = t.org
        actRole = t.role
      }
      // Live-only, by design: a checkpoint queue awaiting human approval defeats
      // the point (the layer must be current when the next session pulls it).
      if (!roleAllows(actRole, "publish"))
        return text(
          "Checkpointing needs publish rights (a Creator/Admin grant). Re-authorize with a publish scope.",
        )
      if (!existing && !work?.trim())
        return text(
          "First checkpoint of a piece of work — pass `work` (a short name). The result returns the lineage's short_id to pass on every checkpoint after.",
        )
      if (existing) {
        if (existing.kind !== "file")
          return text(`"${short_id}" is a bundle — a lineage is a single-page document.`)
        // A checkpoint REPLACES the whole page, so it only ever writes pages the
        // tool itself authored — never a doc someone reached with a mistyped id.
        const v = await ctx.meta.getVersion(existing.id, existing.current_version)
        const src = v ? await ctx.sourceText(v) : null
        if (!src?.startsWith(LINEAGE_MARKER))
          return text(
            `"${short_id}" doesn't start with the lineage marker (not a page this tool maintains, or its content is unreadable) — refusing to replace it. Omit short_id to start a new lineage.`,
          )
      }
      const shortId = existing ? existing.short_id : newShortId()
      const title = existing ? (existing.title ?? "Untitled work") : (work as string).trim()
      // No layer number in the body or the pinned name: the artifact's version IS
      // the layer number, and only the store knows it race-free — two concurrent
      // checkpoints would both compute current_version+1 and one would mislabel.
      // Concurrent layers are last-writer-wins on the page; both survive as versions.
      const stamp = new Date().toISOString()
      const content = `${LINEAGE_MARKER}\n\n# ${title}\n\n_Checkpointed ${stamp} by ${agent.name}_\n\n## State\n\n${cleanField(state.trim())}\n${layerSection("Decisions", decisions)}${layerSection("Open", open)}${layerSection("Next", next)}${layerSection("Refs", refs)}\n## Continue from here\n\nPaste in a terminal on any machine with the Derive MCP connected:\n\n\`\`\`\nclaude "Read Derive artifact ${shortId} with the read tool, continue the work it describes, and checkpoint back to ${shortId} at each task boundary."\n\`\`\`\n`
      if (content.length > MAX_LAYER_CHARS)
        return text(
          `A layer is one page — ${MAX_LAYER_CHARS} chars max, this is ${content.length}. Trim to what a cold session needs; replace detail with refs.`,
        )
      const bytes = new TextEncoder().encode(content)
      // A checkpoint is always a live publish (no propose concept here), so it's gated
      // the same as any other publish/approve choke point.
      const blocked = await ctx.billingBlocked(targetOrg)
      if (blocked) return text(blocked.message)
      // Same workspace storage cap the HTTP routes and the publish `edits` path
      // enforce — checkpoint fires repeatedly by design, so it's the MCP path
      // most likely to accrete blobs past an exceeded quota.
      if (await ctx.overStorage(targetOrg, bytes.length))
        return text("The workspace's storage quota is exceeded — checkpoint not saved.")
      try {
        const settings = existing ? null : await ctx.meta.getOrgSettings(targetOrg)
        const { artifact, version } = await publishVersion(
          ctx.meta,
          ctx.blobs,
          {
            bytes,
            filename: "lineage.md",
            isBundle: false,
            title: existing ? undefined : title,
            message: state.trim().slice(0, 80),
            author: agent.name,
            authorId: actingFor?.id ?? null,
            source: "mcp",
            name: `layer ${stamp.slice(0, 16)}Z`,
            orgId: targetOrg,
            workspaceAccess: settings?.defaultWorkspaceAccess,
            linkRole: settings?.defaultLinkRole,
            // Never auto-list working state: a lineage carries decisions, open
            // threads, and file paths. Teammates reach it via workspace access /
            // the pasted link; it must not surface in the library or public
            // directory by org default — a human promotes it deliberately.
            // (Also moots publish's two listed-invariant checks: nothing listed.)
            listed: "none",
            mintShortId: existing ? undefined : shortId,
          },
          existing ? shortId : undefined,
        )
        if (!existing)
          await ctx.meta.setArtifactMember({
            id: newId("am"),
            artifact_id: artifact.id,
            user_id: actingFor?.id ?? agent.id,
            role: "owner",
          })
        // Same fan-out as a publish (realtime, render, webhooks, search) — a
        // lineage is an ordinary artifact everywhere downstream.
        await afterPublish(
          {
            meta: ctx.meta,
            blobs: ctx.blobs,
            bus: ctx.bus,
            notify: ctx.notify,
            notifyRender: ctx.notifyRender,
            background: ctx.background,
            search: ctx.search,
          },
          artifact,
          version,
          { isNew: !existing, onBehalf: actingFor?.id ?? null, resolves: [], actorId: agent.id },
        )
        return json({
          checkpointed: true,
          short_id: artifact.short_id,
          version: version.n,
          url: artifactUrl(ctx.deps.baseUrl, artifact),
          note: existing
            ? "Layer replaced — versions keep the history."
            : `Lineage created. Pass short_id "${artifact.short_id}" on every future checkpoint (record it, e.g. in .derive/lineage).`,
        })
      } catch (e) {
        const msg = e instanceof PublishError ? e.message : "could not checkpoint"
        return text(`Checkpoint failed: ${msg}`)
      }
    },
  )
}

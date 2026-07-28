// The per-request tool context: every value + shared closure a tool handler sources
// from, built once per MCP connection by makeToolContext(base). buildServer (mcp.ts)
// resolves the raw per-request values — identity, grant scope, the pending-request
// inbox, the resolved brand profile — and hands them in as `base`; this factory adds the
// closures more than one tool shares: workspace resolution (grantedWorkspaces / inGrant /
// resolveWs), artifact reach (reach / notFound), the shared `workspace` arg schema, the
// work queue, and the askable-contexts lookup. Each per-tool module (mcp-tools/*) then
// takes one `tc: ToolContext` and destructures exactly what it needs, so the tool bodies
// are byte-for-byte the closures they were inline.

import {
  AGENT_INBOX_PAGE,
  type AgentMentionRecord,
  type AgentRecord,
  type ArtifactRecord,
  type ContextRecord,
  capRole,
  type Role,
} from "@derive/core"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { AppContext } from "./context"
import { err, json } from "./mcp-util"

// The raw per-request values buildServer resolves and hands to makeToolContext.
export interface ToolContextBase {
  server: McpServer
  ctx: AppContext
  agent: AgentRecord
  actingFor: { id: string; name: string | null } | null
  ownerId: string | null
  scopeForCap: Role
  registered: boolean
  boundWorkspaces: string[]
  /** The OAuth client behind this connection ("" for a registered dk_agt_ token) —
   *  provenance stamped into tokens minted by `stage target:'api'`. */
  clientId: string
  /** This connection is itself a minted dkapi_ token: the mint refuses to chain off
   *  one, so a leaked token can't renew its own short TTL forever. */
  mintedToken: boolean
  defaultOrg: string
  defaultRole: Role
  pendingRequests: AgentMentionRecord[]
  bpProfile: { state: "pending" | "live"; shortId: string } | undefined
  profileArt: ArtifactRecord | null
}

// The `workspace` argument shared by every workspace-scoped tool.
const wsArg = z
  .string()
  .optional()
  .describe(
    "Workspace to act in — its id or name from list_workspaces. Omit for your default workspace; read/catch_up/comment also find a short_id in ANY of your workspaces automatically.",
  )

export interface ToolContext extends ToolContextBase {
  grantedWorkspaces: () => Promise<{ id: string; name: string; role: Role }[]>
  inGrant: (org: string) => boolean
  resolveWs: (ref?: string) => Promise<{ org: string; role: Role } | { error: string }>
  reach: (
    shortId: string,
    wsRef?: string,
  ) => Promise<{ a: ArtifactRecord; org: string; role: Role } | { error: string } | null>
  notFound: (shortId: string) => ReturnType<typeof err>
  wsArg: typeof wsArg
  workQueue: (ack?: string[], wait?: number) => Promise<ReturnType<typeof json>>
  askableContexts: (
    org: string,
    userId: string,
  ) => Promise<{ x: ContextRecord; manifest: ArtifactRecord | null }[]>
}

export function makeToolContext(base: ToolContextBase): ToolContext {
  const {
    ctx,
    agent,
    actingFor,
    ownerId,
    scopeForCap,
    registered,
    boundWorkspaces,
    defaultOrg,
    defaultRole,
    pendingRequests,
  } = base

  // The owner's workspaces this grant can actually reach: all of them when the
  // grant is unscoped (empty set), else only the ticked subset. The single source
  // of truth for what list_workspaces shows and what the `workspace` arg accepts.
  const grantedWorkspaces = async (): Promise<{ id: string; name: string; role: Role }[]> => {
    if (!ownerId) return []
    const all = await ctx.meta.listWorkspaces(ownerId)
    return boundWorkspaces.length ? all.filter((w) => boundWorkspaces.includes(w.id)) : all
  }
  // Is an org within this grant's scope? (An unscoped grant reaches all.)
  const inGrant = (org: string) => boundWorkspaces.length === 0 || boundWorkspaces.includes(org)

  // Resolve a workspace REFERENCE (id or name) to an org + the role the grant
  // holds there. No ref → the connection's default workspace. Roaming needs a
  // known granting user (ownerId); the role is re-capped from the grant's scope
  // against that workspace's membership — the same rule as agentFor's
  // X-Derive-Workspace re-home. Returns an actionable error the model recovers from.
  const resolveWs = async (
    ref?: string,
  ): Promise<{ org: string; role: Role } | { error: string }> => {
    if (!ref) return { org: defaultOrg, role: defaultRole }
    if (!ownerId)
      return {
        error:
          "This connection is pinned to a single workspace and can't switch. Reconnect it with an OAuth login to reach your other workspaces.",
      }
    // Only workspaces WITHIN THE GRANT are resolvable — one outside the ticked set
    // is as good as non-existent to this connection, even if the owner belongs to it.
    const mine = await grantedWorkspaces()
    const w =
      mine.find((x) => x.id === ref) ??
      mine.find((x) => x.name.toLowerCase() === ref.trim().toLowerCase())
    if (!w)
      return {
        error: `No workspace "${ref}" in this grant. Call list_workspaces to see the workspaces this connection can act in (match by id or name).`,
      }
    return { org: w.id, role: capRole(scopeForCap, w.role) }
  }

  // Reach an artifact this connection can act on, resolving WHERE it lives.
  // With `wsRef`: only that workspace. Without: the default workspace, then —
  // for a bare short_id — ANY workspace the granting user belongs to, so a doc
  // is found wherever it lives without the model naming the workspace.
  // `workspace_access = none` narrows further: touchable only through the
  // agent's human (or a legacy row of the agent's own) — a teammate's
  // invite-only draft stays invisible over MCP.
  // Returns the artifact plus the org + re-capped role to act with there.
  const reach = async (
    shortId: string,
    wsRef?: string,
  ): Promise<{ a: ArtifactRecord; org: string; role: Role } | { error: string } | null> => {
    const a = await ctx.meta.getByShortId(shortId)
    if (!a) return null
    let org = defaultOrg
    let role = defaultRole
    if (wsRef) {
      const t = await resolveWs(wsRef)
      if ("error" in t) return t
      if (a.org_id !== t.org) return null // named a workspace this artifact isn't in
      org = t.org
      role = t.role
    } else if (a.org_id !== defaultOrg) {
      // Auto-roam to the doc's workspace only if it's within this grant and the
      // owner is a member. A doc in a workspace outside the grant reads as not found.
      if (!ownerId || !inGrant(a.org_id)) return null
      const m = await ctx.meta.getMembership(a.org_id, ownerId)
      if (!m) return null
      org = a.org_id
      role = capRole(scopeForCap, m.role)
    }
    if (a.workspace_access !== "member") {
      const ok =
        (actingFor && (await ctx.meta.getArtifactMember(a.id, actingFor.id))) ||
        (await ctx.meta.getArtifactMember(a.id, agent.id))
      if (!ok) return null
    }
    // A taken-down artifact serves NO content, mirroring the web /raw 410: read, find,
    // comment, and publish all resolve through here, so gating it once covers every
    // one-artifact tool. It stays visible as a tombstone in find's browse rows (metadata
    // only). Checked AFTER the reach/membership gates so it never confirms a removed
    // short_id to someone who couldn't have reached it anyway (they still get notFound).
    if (a.removed_at) return { error: `"${shortId}" was taken down and is no longer available.` }
    return { a, org, role }
  }
  const notFound = (shortId: string) =>
    err(
      `No artifact "${shortId}" you can reach in any of your workspaces. Call find (optionally with a workspace) to see what's there.`,
    )

  // WORK QUEUE — what teammates asked this agent to do (a MODE of catch_up: no short_id).
  // The pull inbox behind the ask-agent and Rework buttons: a teammate @mentions this
  // agent in a comment and the request waits here until some session of the agent reads
  // and acks it. catch_up with no short_id returns it; only a REGISTERED workspace agent
  // has an inbox (an OAuth grant's id is oauth:<client>, which no @mention can name), so a
  // connection without one gets an explicit note instead of a bare empty list.
  const workQueue = async (ack?: string[], wait?: number) => {
    // No inbox at all: say so, rather than returning [] the agent might read as "no work".
    if (!registered)
      return json({
        acked: 0,
        pending: [],
        note: "This connection has no inbox — @mentions can't name an OAuth grant, so there's no work queue here (a registered workspace agent has one). Pass a short_id to catch up on an artifact instead.",
      })
    // The queue this request already read at connect (a fresh server per request, so it
    // is this call's snapshot). `acked` counts what actually LEFT the queue, so acking is
    // idempotent: the store matches a row whether or not it was already acknowledged, so
    // an unknown or repeated id would otherwise inflate the count.
    const queue = pendingRequests
    const handled = new Set((ack ?? []).filter((id) => queue.some((m) => m.id === id)))
    let acked = 0
    for (const id of handled) if (await ctx.meta.ackAgentMention(agent.id, id)) acked++
    let pending = queue.filter((m) => !handled.has(m.id))

    // Long-poll: when nothing is pending, subscribe to this agent's channel, then RE-READ
    // fresh (a request may have landed since connect, or during the wait) — the same
    // check-then-wait gap close catch_up uses. The event is only a wake signal; we always
    // answer from a fresh store read, so a missed or raced wake is never a wrong answer.
    if (wait && pending.length === 0 && ctx.bus.waitFor) {
      const release = new AbortController()
      const woke = ctx.bus
        .waitFor(`u:${agent.id}`, ["request.created"], wait * 1000, release.signal)
        .catch(() => null)
      const fresh = await ctx.meta.listPendingAgentMentions(agent.id, AGENT_INBOX_PAGE)
      if (fresh.length) {
        release.abort()
        await woke
      } else {
        await woke
      }
      pending = fresh.length
        ? fresh
        : await ctx.meta.listPendingAgentMentions(agent.id, AGENT_INBOX_PAGE)
    }
    return json({
      acked,
      pending: pending.map((m) => ({
        id: m.id,
        artifact: m.artifact_short_id,
        thread: m.thread_id,
        author: m.author,
        request: m.body,
        created_at: m.created_at,
      })),
    })
  }

  // The contexts `userId` may ask in `org`, each with its manifest (identity +
  // the current version a new session pins). One listContexts + one batched
  // artifact read; the per-context grant checks are membership/roster lookups.
  const askableContexts = async (org: string, userId: string) => {
    const rows = await ctx.meta.listContexts(org)
    const mine: ContextRecord[] = []
    for (const x of rows) if (await ctx.canUserAskContext(userId, x)) mine.push(x)
    const manifests = await ctx.meta.getArtifactsByIds(mine.map((x) => x.manifest_artifact_id))
    const byId = new Map(manifests.map((a) => [a.id, a]))
    return mine.map((x) => ({ x, manifest: byId.get(x.manifest_artifact_id) ?? null }))
  }

  return {
    ...base,
    grantedWorkspaces,
    inGrant,
    resolveWs,
    reach,
    notFound,
    wsArg,
    workQueue,
    askableContexts,
  }
}

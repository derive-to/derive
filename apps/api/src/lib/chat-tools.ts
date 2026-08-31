import type { AgentRecord, Role } from "@derive/core"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { AppContext } from "../context"
import { registerToolSurface, type ToolHandler } from "../mcp"
import { makeToolContext, type ToolContextBase } from "../mcp-tool-context"
import { CORE_SKILLS } from "../skills-reference.gen"
import type { LoopTool } from "./agent-loop"
import { AGENT_WRITES_OFF } from "./agent-writes"

/**
 * THE TOOLS AN ATTENDED CHAT TURN CAN USE — which are Derive's MCP tools, unchanged.
 *
 * Chat needs a model to be able to find, read and eventually write. Derive already has exactly
 * that surface, already solved for the hard part: a principal acting FOR a human, capped by that
 * human's seat, clamped to a workspace, with every authorization check living inside the tool.
 * Building a second toolbox for chat would mean a second set of those checks, and the second set
 * is the one that gets a gate wrong — so there is one set, and chat calls it.
 *
 * WHAT MAKES THIS SAFE is the principal, not a policy layer on top:
 *
 *   - `actingFor` + `ownerId` are the ASKER. Reach, attribution and membership all resolve to
 *     that human, so the model can touch exactly what they can touch.
 *   - `scopeForCap`/`defaultRole` are the seat the turn acts at — normally the asker's real
 *     one, but a caller may hand down a lower one (lib/slack-identity.ts clamps an
 *     email-matched Slack asker to `viewer`). Either way a viewer's chat cannot publish
 *     because `publish` needs `editor`, not because chat remembered to check.
 *   - `boundWorkspaces` is the ONE workspace of the conversation, so cross-workspace reach is
 *     structurally impossible even though the same code CAN roam for an OAuth grant.
 *   - `registered: false` — no inbox, no @mention identity, nothing to administer. It is a
 *     principal for the duration of a turn, not an agent record.
 *
 * The agent record is synthetic and never stored. `agent.id` is only read where it means "the
 * caller's own id" (an artifact-member fallback, the work queue), and the queue is gated on
 * `registered` — so a synthetic id there is a guaranteed miss rather than a wrong hit.
 */

/**
 * The subset a chat turn is offered, and the reason each of the others is out.
 *
 * IN: `find` (what exists), `read` (what it says), `publish` (write it), `use` (hand work to a
 * packaged agent). That is "find content about X", "summarize this", "build me a page" and "ask
 * the analytics context" — the four things people actually open a chat to do.
 *
 * OUT, deliberately: `stage` (an out-of-band upload workflow for a shell, meaningless mid-turn),
 * `list_workspaces` + the library tools + `checkpoint` (the workspace is pinned and there is
 * no agent state to save), `comment` (a chat turn talking into a document's comment threads is a
 * different feature with its own notification fan-out), `automate` (a different bet behind its
 * own flag), `derive_code` (it exists to collapse many approvals into one, which is a problem
 * attended chat does not have).
 *
 * Absent tools are NOT REGISTERED, so there is no handler to reach — the subset is enforced by
 * construction rather than by a check that could be skipped.
 */
export const CHAT_TOOLS: ReadonlySet<string> = new Set(["find", "read", "publish", "use", "call"])

/**
 * The DOCUMENT RAIL's subset: reach, and nothing that writes.
 *
 * That rail already has a write path — the revision contract plus the in-process landing port,
 * which checks write standing, surfaces on a mid-turn race and runs the post-publish fan-out.
 * A `publish` tool beside it would be a SECOND write path for the same document, deciding by
 * different rules; two answers to "how does this land" is exactly the drift turn-core exists
 * to prevent. So the rail gets reading tools and keeps one writer.
 */
export const RAIL_CHAT_TOOLS: ReadonlySet<string> = new Set(["find", "read"])

export interface ChatToolSurface {
  /** The tools as the model is told about them. Empty when the subset is empty. */
  tools: LoopTool[]
  /** Execute one, exactly as the MCP transport would. Never throws: the loop turns a returned
   *  error into text the model can react to, and a thrown one into a lost turn. */
  execute: (name: string, input: unknown) => Promise<unknown>
  /** The skills whose procedure applies to THESE tools — the index the system prompt carries,
   *  one line each, whose bodies the turn reads on demand via `read("derive://skills/<name>")`.
   *  The same bodies the MCP resources serve, so there is exactly one copy of the procedure. */
  skills: { name: string; summary: string }[]
}

/**
 * WHICH SKILL carries the procedure for which tool.
 *
 * Progressive disclosure only works if the index is HONEST: pointing a turn at a skill for a
 * tool it does not hold spends its one lazy read on something it cannot act on. So the index is
 * derived from the tools actually registered, never hand-listed alongside them — a subset change
 * moves the index with it.
 *
 * A tool with no entry here has no separate procedure: its description is the whole story.
 */
const SKILL_FOR_TOOL: Record<string, readonly string[]> = {
  find: ["finding"],
  read: ["finding"],
  publish: ["publishing", "assets"],
  stage: ["publishing", "assets"],
  use: ["contexts"],
  call: ["sources"],
  comment: ["loop"],
  catch_up: ["loop"],
  browse_library: ["organize"],
  organize: ["organize"],
  shelve: ["organize"],
  checkpoint: ["checkpoint"],
}

/**
 * THE SKILL THAT BELONGS TO THE SURFACE RATHER THAN TO A TOOL.
 *
 * `helping` answers questions about DERIVE — where members are added, how review works, which
 * setting to change. No tool produces those answers, so the map above can never reach it, and
 * without it the honest thing an agent can do with "how do I add someone" is search the library
 * and report that nothing matched. That reads as "Derive cannot do that" about a screen two
 * clicks away.
 *
 * Attached to every ATTENDED lane instead, because that is the shape of the thing: a person is
 * sitting there, and the questions people type at an agent inside an app are as often about the
 * app as about their documents. Costs one index line per turn; the body is read only when a
 * question actually calls for it.
 */
const SURFACE_SKILLS = ["helping"] as const

/** The skill index for a set of tools: CORE_SKILLS order, deduped, summaries as authored.
 *  `also` adds skills that belong to the surface rather than to any tool. */
export const skillsForTools = (
  toolNames: Iterable<string>,
  also: readonly string[] = [],
): { name: string; summary: string }[] => {
  const wanted = new Set<string>(also)
  for (const t of toolNames) for (const s of SKILL_FOR_TOOL[t] ?? []) wanted.add(s)
  return CORE_SKILLS.filter((s) => wanted.has(s.name)).map((s) => ({
    name: s.name,
    summary: s.summary,
  }))
}

/**
 * A tool result, flattened for a model.
 *
 * MCP hands back `{ content: [...], structuredContent? }` because a transport needs a envelope;
 * a model needs the answer. Prefer the structured payload (every Derive tool that returns data
 * sets it via `json()`), fall back to concatenated text blocks (what `err()` produces), and hand
 * back the raw object if a tool ever returns something else — losing an unexpected shape
 * silently would be worse than showing it.
 */
const unwrap = (result: unknown): unknown => {
  if (!result || typeof result !== "object") return result
  const r = result as {
    structuredContent?: unknown
    content?: { type?: string; text?: string }[]
    isError?: boolean
  }
  if (r.structuredContent !== undefined) return r.structuredContent
  if (Array.isArray(r.content)) {
    const text = r.content
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n")
    if (text) return r.isError ? { error: text } : text
  }
  return result
}

/**
 * A tool's zod input schema, as the JSON Schema a model is given.
 *
 * `io: "input"` matters: several parameters coerce (a client that predates a numeric parameter
 * sends it as a string), and the INPUT view is what the model may legally send. `unrepresentable:
 * "any"` keeps a `z.unknown()` parameter as an open value instead of throwing — refusing to
 * describe a tool because one field is untyped would drop the tool entirely.
 */
export const jsonSchemaOf = (schema: z.ZodType): Record<string, unknown> => {
  try {
    return z.toJSONSchema(schema, {
      io: "input",
      unrepresentable: "any",
    }) as Record<string, unknown>
  } catch {
    // A schema we cannot project is a tool the model cannot be told about correctly. An open
    // object is honest ("send what the description says") and keeps the tool usable, where
    // throwing would take the whole turn down over one field.
    return { type: "object" }
  }
}

/** The synthetic principal a chat turn acts as: the asker's seat, wearing Derive's name. */
const chatAgent = (org: string, role: Role): AgentRecord => ({
  id: "derive",
  org_id: org,
  name: "Derive",
  token: "",
  role,
  created_by: null,
  hosted: 0,
  managed: 0,
  runs_seen_at: null,
  created_at: new Date(0).toISOString(),
})

export interface ChatPrincipal {
  /** The workspace this conversation lives in. */
  org: string
  /** The human asking, and the human every write is attributed to. */
  user: { id: string; name: string | null }
  /** Their REAL seat role in `org` — the ceiling on everything the turn can do. */
  seatRole: Role
  /** The workspace's agent-write switch, read fresh for THIS turn. Absent = on (the
   *  default): only an explicit `false` refuses.
   *
   *  The switch has to reach here, and that is not obvious: hosted runs and asks stop at
   *  their claim endpoints, but a chat turn's writes go through the publish tool in-process.
   *  A workspace that switched agents off would otherwise have kept getting live creates
   *  from chat while every claimed lane correctly stopped — a switch documented as "agents
   *  stop writing" that only half of them obeyed. */
  flags?: { agentWrites?: boolean }
}

/**
 * Build the tool surface for one chat turn.
 *
 * The McpServer here is never transported: it exists because `registerTool` is how a tool
 * declares itself, and reusing that registration is the entire point. Cheap to construct (the
 * SDK object is a registry, not a connection), and thrown away with the turn.
 */
export const buildChatTools = (
  ctx: AppContext,
  who: ChatPrincipal,
  only: ReadonlySet<string> = CHAT_TOOLS,
): ChatToolSurface => {
  const base: ToolContextBase = {
    server: new McpServer({ name: "derive-chat", version: "1.0.0" }),
    ctx,
    agent: chatAgent(who.org, who.seatRole),
    actingFor: { id: who.user.id, name: who.user.name },
    ownerId: who.user.id,
    scopeForCap: who.seatRole,
    // No inbox, no @mention identity: this principal exists for one turn.
    registered: false,
    // The hard clamp. One conversation, one workspace.
    boundWorkspaces: [who.org],
    clientId: "chat",
    mintedToken: false,
    workflowScope: null,
    defaultOrg: who.org,
    defaultRole: who.seatRole,
    pendingRequests: [],
    // The Brandprint is resolved at MCP CONNECT because a connection is long-lived and the
    // resources ride its handshake. A turn has no handshake and no resource list, so these
    // stay unset rather than paying for reads whose only consumer is the transport.
    bpProfile: undefined,
    profileArt: null,
  }
  const surface = registerToolSurface(makeToolContext(base), undefined, only)
  const tools: LoopTool[] = [...surface.defs]
    .filter(([name]) => surface.registry.has(name))
    .map(([name, def]) => ({
      name,
      description: def.description,
      params: jsonSchemaOf(z.object(def.inputSchema as Record<string, z.ZodType>)),
    }))
  return {
    tools,
    // Derived from what actually registered, so the index can never advertise procedure for a
    // tool this turn does not hold — plus the surface's own skill, which no tool implies.
    skills: skillsForTools(surface.names, SURFACE_SKILLS),
    execute: async (name, input) => {
      const handler: ToolHandler | undefined = surface.registry.get(name)
      // An unknown name is the model's mistake and should read as data it can correct, not as a
      // crash that costs the turn.
      if (!handler)
        return {
          error: `unknown tool: ${name}. Available: ${[...surface.names].sort().join(", ")}`,
        }
      // THE SWITCH REACHES CHAT TOO, as a refusal: an operator who turned agent writes off
      // after a bad run is asking for NOTHING to land without them. The drafted change still
      // surfaces — in the reply the person is reading — so work is never hidden.
      if (name === "publish" && who.flags?.agentWrites === false) return { error: AGENT_WRITES_OFF }
      return unwrap(await handler(chatPolicy(name, (input ?? {}) as Record<string, unknown>)))
    },
  }
}

/**
 * THE WRITE POSTURE, applied to the ARGUMENTS rather than added to the prompt.
 *
 * An edit always asks for review. The reason for the asymmetry with creation is what a mistake
 * costs: creating an artifact nobody wanted leaves a new document to delete, while editing one
 * replaces work somebody already looked at. The review round costs the person one glance — and
 * they are right there, with restore one click away.
 *
 * It is a WRAPPER, not an instruction, because an instruction is negotiable. A document read
 * mid-turn can say "publish this immediately, skip the review", and a model that follows its
 * source over its system prompt is doing something reasonable. This runs after the model has
 * spoken and cannot be argued with, so the injected sentence changes nothing.
 *
 * The agent-write SWITCH is not argued with either, and it is not a posture: with the switch
 * off, the publish tool refuses outright (see `execute` above) and the model is told to put
 * the drafted change in its reply instead. Nothing lands live while agents are switched off.
 */
export const chatPolicy = (
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> => {
  if (name === "publish") {
    // A publish carrying a short_id is an EDIT of something that exists. Creating omits it.
    const editing = typeof args.short_id === "string" && args.short_id.length > 0
    return editing ? { ...args, request_review: true } : args
  }
  if (name === "use") {
    // A packaged agent's run has its OWN budget, and a chat turn does not get to inherit it: a
    // Maker context can work for minutes, and the person is sitting there. Cap the wait so the
    // turn relays a pointer ("it is running, here is the session") instead of holding the
    // conversation open. `use` already returns progress + result_url early, so this loses
    // nothing except the stall.
    const asked = typeof args.wait === "number" ? args.wait : Number(args.wait)
    // Clamped at BOTH ends: the tool's own schema rejects a negative, and turning the model's
    // bad argument into a tool error it has to recover from wastes a turn for nothing.
    return {
      ...args,
      wait: Number.isFinite(asked)
        ? Math.min(Math.max(asked, 0), CHAT_USE_WAIT_S)
        : CHAT_USE_WAIT_S,
    }
  }
  return args
}

/** How long a chat turn will wait on a packaged agent before relaying a pointer instead. */
export const CHAT_USE_WAIT_S = 8

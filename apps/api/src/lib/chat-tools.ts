import type { AgentRecord, Role } from "@derive/core"
import { capRole, syntheticAgent } from "@derive/core"
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
 * IN: `find` (what exists), `read` (what it says), `publish` (write it), and `call` (the
 * workspace's connected sources). That is "find content about X", "summarize this", "build me a
 * page" and "look this up in the tool we connected", the things people actually open a chat to do.
 *
 * OUT, deliberately: `stage` (an out-of-band upload workflow for a shell, meaningless mid-turn),
 * `list_workspaces` + the library tools + `checkpoint` (the workspace is pinned and there is
 * no agent state to save), `comment` (a chat turn talking into a document's comment threads is a
 * different feature with its own notification fan-out), the agent tools (`agents`, `ask`, `jobs`,
 * `pull`: handing work to an agent is a person's decision, not a chat turn's), `derive_code` (it exists to collapse many approvals into one, which is a problem
 * attended chat does not have).
 *
 * Absent tools are NOT REGISTERED, so there is no handler to reach — the subset is enforced by
 * construction rather than by a check that could be skipped.
 */
export const CHAT_TOOLS: ReadonlySet<string> = new Set([
  "find",
  "read",
  "catch_up",
  "publish",
  "call",
])

// Chat offers the ordinary artifact workflow. Rich MCP transport and sharing controls
// stay on MCP. The same schemas and handlers still validate and authorize each call.
const CHAT_FIELDS: Record<string, readonly string[]> = {
  find: ["query", "short_id", "tag", "in", "context", "max_matches", "templates", "skills"],
  read: ["short_id", "format", "section", "focus", "lines", "map", "node", "version"],
  catch_up: ["short_id", "since_version", "comments", "response_format"],
  publish: [
    "short_id",
    "base_version",
    "title",
    "content",
    "filename",
    "files",
    "edits",
    "message",
    "request_review",
    "derived_from",
  ],
}

const CHAT_DESCRIPTIONS: Record<string, string> = {
  find: "Find accessible artifacts in this chat workspace. Search by query or short_id. Read each likely match before answering. Omit unused optional fields.",
  read: "Read an artifact by short_id, or a derive://skills URI. Use format markdown for text. Omit section to get the normal document; section * reads all. Use focus only for a real phrase. Omit unused optional fields.",
  catch_up:
    "Read current versions and comments for one artifact. Use short_id and optionally since_version. Read before editing an existing artifact.",
  publish:
    "Create or revise an artifact in this workspace. Create with title, filename, and content. Revise with short_id, base_version, and focused edits or content. An edit has old_str and new_str, or a quote with exact text. Use a base version you read. An existing edit requests review. Omit unused optional fields. A result confirms what actually saved.",
}

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
const chatAgent = (org: string, role: Role): AgentRecord =>
  syntheticAgent({ id: "derive", org_id: org, name: "Chat", role })

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
   *  The switch has to reach here, and that is not obvious: agent jobs stop at their claim
   *  and dispatch, but an @Derive turn's writes go through the publish tool in-process. A
   *  workspace that switched agents off would otherwise have kept getting live creates from
   *  @Derive while every job correctly stopped: a switch documented as "agents stop writing"
   *  that only half of them obeyed. */
  flags?: { agentWrites?: boolean }
}

/** Build the tool surface for one chat turn. */
export const buildChatTools = (
  ctx: AppContext,
  who: ChatPrincipal,
  only: ReadonlySet<string> = CHAT_TOOLS,
): ChatToolSurface =>
  surfaceFor(
    {
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
      defaultOrg: who.org,
      defaultRole: who.seatRole,
      pendingRequests: [],
      // The Brandprint is resolved at MCP CONNECT because a connection is long-lived and the
      // resources ride its handshake. A turn has no handshake and no resource list, so these
      // stay unset rather than paying for reads whose only consumer is the transport.
      bpProfile: undefined,
      profileArt: null,
    },
    only,
    {
      fields: CHAT_FIELDS,
      descriptions: CHAT_DESCRIPTIONS,
      policy: chatPolicy,
      writesOff: who.flags?.agentWrites === false,
    },
  )

/**
 * THE DERIVE TOOLS A JOB'S MODEL CAN USE ON A DERIVE MACHINE.
 *
 * A Derive machine's model holds no Derive credential: the runner keeps its job key out of the
 * model's environment, and the only thing the model gets is the job's tool token, which reaches
 * this job's tool route and nothing else. So without these, an agent that keeps notes in a page
 * cannot open that page. On an owner's machine the model has whatever Derive login that machine
 * has; here, the tool route runs these in-process instead, as the agent itself.
 *
 * `agents`, `ask`, `jobs` and `pull` stay out (handing work on is a person's decision, and a job
 * pulling work would be a runner), as do `stage` (an upload workflow for a shell holding a real
 * bearer) and `derive_code`.
 */
export const JOB_TOOLS: ReadonlySet<string> = new Set([
  "find",
  "read",
  "catch_up",
  "comment",
  "publish",
])

// The chat fields, plus what a standing agent keeps up with: tags on what it publishes, the
// threads an edit answers, and the comment loop. Sharing controls stay on MCP.
const JOB_FIELDS: Record<string, readonly string[]> = {
  ...CHAT_FIELDS,
  publish: [...(CHAT_FIELDS.publish ?? []), "tags", "addresses"],
  comment: ["short_id", "body", "reply_to", "quote", "react", "set_state", "mentions"],
}

/** The prefix a job's Derive tools carry, so they can never be confused with a source's. */
export const JOB_TOOL_PREFIX = "derive."

/**
 * Build the Derive tool surface for one job, acting as the agent: its own record and role,
 * on behalf of the person who made it, clamped to its workspace. Null when that person no
 * longer holds a seat there, the same rule that retires the agent's registered key.
 */
export const buildJobTools = async (
  ctx: AppContext,
  agent: AgentRecord,
): Promise<ChatToolSurface | null> => {
  if (!agent.created_by) return null
  const [seat, [owner]] = await Promise.all([
    ctx.meta.getMembership(agent.org_id, agent.created_by).catch(() => null),
    ctx.meta.getUsers([agent.created_by]).catch(() => []),
  ])
  if (!seat) return null
  const role = capRole(agent.role, seat.role)
  return surfaceFor(
    {
      server: new McpServer({ name: "derive-job", version: "1.0.0" }),
      ctx,
      agent: { ...agent, role },
      actingFor: { id: agent.created_by, name: owner?.name ?? null },
      ownerId: agent.created_by,
      scopeForCap: role,
      // The agent's own identity, as its registered key would present it.
      registered: true,
      boundWorkspaces: [agent.org_id],
      clientId: "",
      mintedToken: false,
      defaultOrg: agent.org_id,
      defaultRole: role,
      pendingRequests: [],
      bpProfile: undefined,
      profileArt: null,
    },
    JOB_TOOLS,
    // The agent's own write policy governs its edits; the publish tool applies it.
    { fields: JOB_FIELDS, descriptions: {}, policy: (_n, a) => a },
  )
}

interface SurfaceOptions {
  fields: Record<string, readonly string[]>
  descriptions: Record<string, string>
  policy: (name: string, args: Record<string, unknown>) => Record<string, unknown>
  writesOff?: boolean
}

/**
 * Register a tool surface for one in-process principal and wrap it for a model.
 *
 * The McpServer here is never transported: it exists because `registerTool` is how a tool
 * declares itself, and reusing that registration is the entire point. Cheap to construct (the
 * SDK object is a registry, not a connection), and thrown away with the turn.
 */
const surfaceFor = (
  base: ToolContextBase,
  only: ReadonlySet<string>,
  opts: SurfaceOptions,
): ChatToolSurface => {
  const surface = registerToolSurface(makeToolContext(base), undefined, only)
  const shapeFor = (name: string) => {
    const full = surface.defs.get(name)?.inputSchema as Record<string, z.ZodType> | undefined
    const fields = opts.fields[name]
    return full
      ? Object.fromEntries(Object.entries(full).filter(([key]) => !fields || fields.includes(key)))
      : {}
  }
  const tools: LoopTool[] = [...surface.defs]
    .filter(([name]) => surface.registry.has(name))
    .map(([name, def]) => ({
      name,
      description: opts.descriptions[name] ?? def.description,
      params: jsonSchemaOf(z.object(shapeFor(name))),
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
      if (name === "publish" && opts.writesOff) return { error: AGENT_WRITES_OFF }
      const shape = shapeFor(name)
      const args = opts.policy(
        name,
        input && typeof input === "object" ? (input as Record<string, unknown>) : {},
      )
      // Some compatible models send null for optional arguments. Omit only optional,
      // non-nullable fields. Required and intentionally nullable inputs still validate.
      const normalized = Object.fromEntries(
        Object.entries(args).filter(
          ([key, value]) =>
            !shape[key]?.isOptional() ||
            (value !== null &&
              value !== "" &&
              !(Array.isArray(value) && value.length === 0) &&
              !(
                typeof value === "object" &&
                value !== null &&
                !Array.isArray(value) &&
                Object.keys(value).length === 0
              )) ||
            (value === null && shape[key].isNullable()),
        ),
      )
      const parsed = z.object(shape ?? {}).safeParse(normalized)
      if (!parsed.success)
        return {
          error: `Invalid ${name} arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        }
      if (name === "publish" && parsed.data.short_id && parsed.data.base_version === undefined)
        return {
          error:
            "An existing artifact edit requires base_version. Read the current artifact and use the version you read.",
        }
      return unwrap(await handler(parsed.data))
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
  return args
}

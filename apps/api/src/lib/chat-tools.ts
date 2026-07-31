import type { AgentRecord, Role } from "@derive/core"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { AppContext } from "../context"
import { registerToolSurface, type ToolHandler } from "../mcp"
import { makeToolContext, type ToolContextBase } from "../mcp-tool-context"
import type { LoopTool } from "./agent-loop"

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
 *   - `scopeForCap`/`defaultRole` are their real seat. A viewer's chat cannot publish because
 *     `publish` refuses a viewer, not because chat remembered to check.
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
 * IN: `find` (what exists), `read` (what it says). That is the whole read half, and it is what
 * "find content about X" needs.
 *
 * OUT, deliberately: `stage` (an out-of-band upload workflow for a shell, meaningless mid-turn),
 * `list_workspaces` + `organize` + `checkpoint` (the workspace is pinned and there is no agent
 * state to save), `comment` (a chat turn talking into a document's comment threads is a
 * different feature with its own notification fan-out), `automate` (a different bet behind its
 * own flag), `derive_code` (it exists to collapse many approvals into one, which is a problem
 * attended chat does not have). `publish` and `use` arrive with the write posture, next.
 *
 * Absent tools are NOT REGISTERED, so there is no handler to reach — the subset is enforced by
 * construction rather than by a check that could be skipped.
 */
export const CHAT_TOOLS: ReadonlySet<string> = new Set(["find", "read"])

export interface ChatToolSurface {
  /** The tools as the model is told about them. Empty when the subset is empty. */
  tools: LoopTool[]
  /** Execute one, exactly as the MCP transport would. Never throws: the loop turns a returned
   *  error into text the model can react to, and a thrown one into a lost turn. */
  execute: (name: string, input: unknown) => Promise<unknown>
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
const jsonSchemaOf = (inputSchema: Record<string, unknown>): Record<string, unknown> => {
  try {
    return z.toJSONSchema(z.object(inputSchema as Record<string, z.ZodType>), {
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
      params: jsonSchemaOf(def.inputSchema),
    }))
  return {
    tools,
    execute: async (name, input) => {
      const handler: ToolHandler | undefined = surface.registry.get(name)
      // An unknown name is the model's mistake and should read as data it can correct, not as a
      // crash that costs the turn.
      if (!handler)
        return {
          error: `unknown tool: ${name}. Available: ${[...surface.names].sort().join(", ")}`,
        }
      const args = (input ?? {}) as Record<string, unknown>
      return unwrap(await handler(args))
    },
  }
}

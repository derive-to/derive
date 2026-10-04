import type { ModelMessage as SdkMessage } from "ai"

export interface ModelMessage {
  role: "user" | "assistant"
  content: unknown
}

interface ToolUseBlock {
  id: string
  name: string
  input?: unknown
}
interface ToolResultBlock {
  tool_use_id: string
  content?: unknown
}

const isToolUse = (b: unknown): b is ToolUseBlock =>
  !!b && typeof b === "object" && "id" in b && "name" in b
const isToolResult = (b: unknown): b is ToolResultBlock =>
  !!b && typeof b === "object" && "tool_use_id" in b

export const asMessages = (system: string, messages: ModelMessage[]): SdkMessage[] => {
  // THE SYSTEM PROMPT RIDES IN THE ARRAY rather than in the SDK's `system` option, for two
  // reasons that both matter. Each provider then puts it where its own API wants it (a
  // `role: "system"` message for chat-completions, a top-level field for Anthropic) without this
  // file knowing which. And it means the array is NEVER empty — the SDK rejects an empty prompt
  // outright, while a system-only call is an ordinary thing for a caller to make.
  const out: SdkMessage[] = [{ role: "system", content: system }]
  const nameById = new Map<string, string>()
  for (const m of messages) {
    const blocks = Array.isArray(m.content) ? (m.content as unknown[]) : null
    const results = blocks?.filter(isToolResult) ?? []
    if (results.length) {
      out.push({
        role: "tool",
        content: results.map((r) => ({
          type: "tool-result",
          toolCallId: r.tool_use_id,
          // Falls back rather than throwing: a result whose call we never saw is still the
          // model's own answer coming back, and dropping it is the failure described above.
          toolName: nameById.get(r.tool_use_id) ?? "tool",
          output: {
            type: "text",
            value: typeof r.content === "string" ? r.content : JSON.stringify(r.content ?? ""),
          },
        })),
      })
      continue
    }
    const uses = blocks?.filter(isToolUse) ?? []
    if (uses.length && blocks) {
      for (const u of uses) nameById.set(u.id, u.name)
      // Any prose the same turn produced rides along, which is how a model that narrates before
      // calling a tool keeps its narration.
      const prose = flatten(blocks.filter((b) => !isToolUse(b)))
      out.push({
        role: "assistant",
        content: [
          ...(prose ? [{ type: "text" as const, text: prose }] : []),
          ...uses.map((u) => ({
            type: "tool-call" as const,
            toolCallId: u.id,
            toolName: u.name,
            input: u.input ?? {},
          })),
        ],
      })
      continue
    }
    out.push({ role: m.role, content: flatten(m.content) })
  }
  return out
}

/** Anthropic accepts a bare string OR an array of content blocks; a plain turn wants a string.
 *  Flatten text blocks and drop the rest, so a conversation built for one provider does not
 *  arrive at the other as "[object Object]". */
const flatten = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content)
  return content
    .map((b) => {
      if (typeof b === "string") return b
      const o = b as { type?: string; text?: string; content?: unknown }
      if (o.type === "text" && typeof o.text === "string") return o.text
      // A properly-typed tool RESULT carrying no `tool_use_id` never reaches the fan-out above,
      // so it would otherwise be dropped here — losing the payload the model needs to keep
      // going, silently, rather than failing loudly.
      if (o.type === "tool_result") return typeof o.content === "string" ? o.content : ""
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

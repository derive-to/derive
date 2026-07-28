import { parseRevision, REVISION_CONTRACT, REVISION_NUDGE, type Revision } from "@derive/core"

/**
 * The in-Worker agent loop — Basic execution without a container.
 *
 * Most of what people automate is "read something, think about it, write an artifact". That
 * needs a model and fetch, both of which a Worker does natively, with millisecond cold starts
 * against container-minutes. The container exists because the current executor is a coding-agent
 * CLI that wants a filesystem, a shell and subprocesses — none of which that work requires.
 *
 * Deliberately dependency-free: plain fetch against the Messages API, no Mastra and no AI SDK.
 * That is what lets it run in a Worker at all (a heavy agent framework is exactly the thing that
 * blows a Worker bundle), and it keeps the loop small enough to read in one sitting.
 *
 * It uses the SHARED run contract (@derive/core/run-contract), which is the point: the container
 * executor asks for the same output in the same words and parses replies with the same function,
 * so the two substrates stay comparable and routing between them on cost is a routing decision
 * rather than a change in behaviour.
 *
 * The loop does NOT decide how a write lands. It returns a Revision; the caller runs decideWrite
 * with the workspace flags and the run's taint, exactly as the container path does.
 */

/** One tool the model may call, as the run's least-privilege list already describes it. */
export interface LoopTool {
  name: string
  description: string
  /** JSON-Schema-ish; passed through to the model as input_schema. */
  params: Record<string, unknown>
}

/** A model turn, reduced to what the loop needs. Injected so the loop is testable with no
 *  network and no key — the tests drive it with scripted turns. */
export interface ModelTurn {
  /** Assistant text, concatenated across content blocks. */
  text: string
  /** Tool calls the model wants executed before it can continue. */
  toolUses: { id: string; name: string; input: unknown }[]
  /** Reported spend for this turn in USD, when the provider tells us. Null = unknown. */
  costUsd: number | null
  /** True when the model finished its turn rather than pausing for tools. */
  done: boolean
}

export interface ModelMessage {
  role: "user" | "assistant"
  content: unknown
}

export interface AgentLoopInput {
  systemPrompt: string
  /** The task: instruction + target source + tool list, built by the caller. */
  prompt: string
  tools: LoopTool[]
  /** Call the model with the conversation so far. */
  callModel: (input: {
    system: string
    messages: ModelMessage[]
    tools: LoopTool[]
  }) => Promise<ModelTurn>
  /** Execute one tool server-side. Errors are RETURNED as text, never thrown — a failing tool
   *  is information the model should react to, not a reason to lose the whole run. */
  executeTool: (name: string, input: unknown) => Promise<unknown>
  /** Hard ceiling on model turns. Bounds spend and wall-clock on a model that loops calling
   *  tools forever; without it a stuck run costs money until the lease expires. */
  maxTurns?: number
}

export type AgentLoopResult =
  | { ok: true; revision: Revision; costUsd: number | null; turns: number }
  | { ok: false; error: string; retryable: boolean; costUsd: number | null; turns: number }

/** Bounded by default. Deep enough for pull-several-sources-then-write, shallow enough that a
 *  runaway loop is caught in seconds rather than at the lease timeout. */
export const DEFAULT_MAX_TURNS = 12

/** Serialize a tool result for the model. Objects go as JSON; an Error becomes its message, so a
 *  failing tool reads as a fact the model can respond to ("that source is down, note it") rather
 *  than terminating the run. */
const resultText = (value: unknown): string => {
  if (value instanceof Error) return `ERROR: ${value.message}`
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? "null"
  } catch {
    return String(value)
  }
}

export const runAgentLoop = async (input: AgentLoopInput): Promise<AgentLoopResult> => {
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS
  const system = input.systemPrompt + REVISION_CONTRACT
  const messages: ModelMessage[] = [{ role: "user", content: input.prompt }]
  // Accumulated across EVERY turn, including the ones that end in failure — a run that burned
  // eight turns and produced nothing still cost money, and the budget sums what is reported.
  let costUsd: number | null = null
  const spend = (c: number | null) => {
    if (typeof c === "number" && Number.isFinite(c)) costUsd = (costUsd ?? 0) + c
  }
  let turns = 0
  let nudged = false

  while (turns < maxTurns) {
    turns += 1
    let turn: ModelTurn
    try {
      turn = await input.callModel({ system, messages, tools: input.tools })
    } catch (e) {
      // The model call itself failed (429, 5xx, a network blip). Retryable: the expensive part
      // has not happened yet and a second attempt may well succeed — the same judgement the
      // container executor makes, with the server owning the retry policy either way.
      return { ok: false, error: (e as Error).message, retryable: true, costUsd, turns }
    }
    spend(turn.costUsd)

    if (turn.toolUses.length > 0) {
      messages.push({ role: "assistant", content: turn.toolUses })
      // Sequential, not parallel: tools here are brokered calls into other people's systems, and
      // a model that asks for six at once should not become six concurrent writes to someone's
      // Gmail. Latency is the right thing to trade for that.
      const results: { tool_use_id: string; content: string }[] = []
      for (const use of turn.toolUses) {
        try {
          results.push({
            tool_use_id: use.id,
            content: resultText(await input.executeTool(use.name, use.input)),
          })
        } catch (e) {
          results.push({ tool_use_id: use.id, content: resultText(e) })
        }
      }
      messages.push({ role: "user", content: results })
      continue
    }

    const parsed = parseRevision(turn.text)
    if (parsed.revision) return { ok: true, revision: parsed.revision, costUsd, turns }

    // A finished turn with no block. Nudge ONCE — models routinely describe the change instead
    // of emitting it, and one reminder recovers the work rather than discarding a completed run.
    // Twice would just pay again for the same failure.
    if (!nudged) {
      nudged = true
      messages.push({ role: "assistant", content: turn.text })
      messages.push({ role: "user", content: REVISION_NUDGE })
      continue
    }
    // Deterministic: a model that ignored the contract twice will ignore it a third time, so
    // this must not look retryable or the run pays for the same answer again.
    return { ok: false, error: parsed.error, retryable: false, costUsd, turns }
  }

  // Ran out of turns still calling tools. Not retryable for the same reason: a loop that could
  // not converge in maxTurns will not converge in another maxTurns.
  return {
    ok: false,
    error: `agent did not produce a revision within ${maxTurns} turns`,
    retryable: false,
    costUsd,
    turns,
  }
}

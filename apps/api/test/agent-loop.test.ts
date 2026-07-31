import { REVISION_CONTRACT } from "@derive/core"
import { describe, expect, it } from "vitest"
import {
  type AgentLoopInput,
  DEFAULT_MAX_TURNS,
  type ModelTurn,
  runAgentLoop,
  TOOL_OUTPUT_BUDGET_CHARS,
} from "../src/lib/agent-loop"
import { answerContract, revisionContract } from "../src/lib/turn-core"

// The in-Worker agent loop — Basic execution without a container.
//
// Driven with SCRIPTED model turns rather than a real model: the loop's job is the control flow
// (when to call tools, when to nudge, when to give up, what counts as retryable), and a test
// against a live model would exercise the model instead. The scripted turns make the failure
// paths reachable at all — a model that loops forever, one that never emits the block, one whose
// tools throw.

const turn = (over: Partial<ModelTurn> = {}): ModelTurn => ({
  text: "",
  toolUses: [],
  costUsd: null,
  done: true,
  ...over,
})

const revisionText = (content = "# Fresh", confidence = 0.9) =>
  `Here you go.\n<revision>${JSON.stringify({ content, filename: "notes.md", confidence })}</revision>`

/** Scripted model: returns the given turns in order, recording what it was asked. */
const scripted = (turns: ModelTurn[]) => {
  const seen: { messages: unknown[]; system: string; tools?: unknown[] }[] = []
  let i = 0
  const callModel: AgentLoopInput["callModel"] = async ({ messages, system, tools }) => {
    seen.push({ messages: [...messages], system, tools })
    const t = turns[Math.min(i, turns.length - 1)]
    i += 1
    return t as ModelTurn
  }
  return { callModel, seen, calls: () => i }
}

const base = (over: Partial<AgentLoopInput>): AgentLoopInput => ({
  system: `You maintain artifacts.${REVISION_CONTRACT}`,
  messages: [{ role: "user", content: "Update the roadmap." }],
  tools: [],
  contract: revisionContract,
  callModel: scripted([turn({ text: revisionText() })]).callModel,
  executeTool: async () => ({ ok: true }),
  ...over,
})

describe("agent loop: the happy path", () => {
  it("returns a parsed revision from a single turn", async () => {
    const out = await runAgentLoop(base({}))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.product.revision?.content).toBe("# Fresh")
    expect(out.product.revision?.confidence).toBe(0.9)
    expect(out.turns).toBe(1)
  })

  it("sends the SHARED revision contract to the model, verbatim", async () => {
    // The whole reason the contract moved into core. If the Worker asked for a different output
    // shape than the container executor, the two substrates would stop being comparable and
    // routing between them on cost would change behaviour rather than just cost.
    const model = scripted([turn({ text: revisionText() })])
    await runAgentLoop(base({ callModel: model.callModel }))
    expect(model.seen[0]?.system).toContain("<revision>")
    expect(model.seen[0]?.system).toContain("NOTHING after it")
  })
})

describe("agent loop: the contract is injected, not assumed", () => {
  // The loop runs three lanes that legitimately ask for different things: an automation wants a
  // revision or nothing happened, an ask wants a revision OR a prose answer. Forking the loop to
  // get that is how the two substrates would stop being comparable, so the contract is a
  // parameter and the control flow around it is one implementation.
  it("an ANSWERABLE contract treats a reply with no block as a product, not a miss", async () => {
    const model = scripted([turn({ text: "It is about three paragraphs long." })])
    const out = await runAgentLoop(base({ callModel: model.callModel, contract: answerContract() }))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.product.revision).toBeNull()
    expect(out.product.prose).toBe("It is about three paragraphs long.")
    // Not nudged: the model chose not to write, which is half the contract, not a failure of it.
    expect(model.calls()).toBe(1)
  })

  it("the SAME reply is a miss under the automation contract, and IS nudged", async () => {
    const model = scripted([turn({ text: "I updated it, trust me." })])
    const out = await runAgentLoop(base({ callModel: model.callModel }))
    expect(out.ok).toBe(false)
    expect(model.calls()).toBe(2)
  })

  it("carries the ask's session-only fields through", async () => {
    const model = scripted([
      turn({
        text: `Here is what I found.\n<revision>${JSON.stringify({
          escalate: true,
          escalation_reason: "the numbers disagree",
          caveats: ["one source was stale"],
        })}</revision>`,
      }),
    ])
    const out = await runAgentLoop(base({ callModel: model.callModel, contract: answerContract() }))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    // A block with no content is an ANSWER that carries session fields — the only way a model
    // can escalate a turn it deliberately wrote nothing on.
    expect(out.product.revision).toBeNull()
    expect(out.product.ask).toMatchObject({
      escalate: true,
      escalationReason: "the numbers disagree",
      caveats: ["one source was stale"],
    })
    expect(out.product.prose).toBe("Here is what I found.")
  })
})

describe("agent loop: tools", () => {
  it("executes tool calls and feeds results back until the model finishes", async () => {
    const executed: { name: string; input: unknown }[] = []
    const model = scripted([
      turn({ toolUses: [{ id: "t1", name: "docs.search", input: { q: "roadmap" } }], done: false }),
      turn({ text: revisionText("# With data") }),
    ])
    const out = await runAgentLoop(
      base({
        callModel: model.callModel,
        tools: [{ name: "docs.search", description: "Search", params: {} }],
        executeTool: async (name, input) => {
          executed.push({ name, input })
          return { hits: 3 }
        },
      }),
    )
    expect(executed).toEqual([{ name: "docs.search", input: { q: "roadmap" } }])
    expect(out.ok && out.product.revision?.content).toBe("# With data")
    expect(out.turns).toBe(2)
    // The tool RESULT has to reach the model, or the second turn is answering blind.
    const second = model.seen[1]?.messages ?? []
    expect(JSON.stringify(second)).toContain("hits")
  })

  it("a throwing tool becomes a message, not a lost run", async () => {
    // A failing source is information the model should react to ("that feed is down, note it"),
    // not a reason to discard work the run has already paid for.
    const model = scripted([
      turn({ toolUses: [{ id: "t1", name: "docs.search", input: {} }], done: false }),
      turn({ text: revisionText("# Degraded") }),
    ])
    const out = await runAgentLoop(
      base({
        callModel: model.callModel,
        executeTool: async () => {
          throw new Error("upstream 503")
        },
      }),
    )
    expect(out.ok).toBe(true)
    expect(JSON.stringify(model.seen[1]?.messages)).toContain("upstream 503")
  })

  it("runs several tool calls in one turn SEQUENTIALLY", async () => {
    // Tools are brokered calls into other people's systems. A model asking for six at once must
    // not become six concurrent writes to someone's Gmail; latency is the right trade.
    const order: string[] = []
    const model = scripted([
      turn({
        toolUses: [
          { id: "a", name: "one", input: {} },
          { id: "b", name: "two", input: {} },
        ],
        done: false,
      }),
      turn({ text: revisionText() }),
    ])
    await runAgentLoop(
      base({
        callModel: model.callModel,
        executeTool: async (name) => {
          order.push(`start:${name}`)
          await new Promise((r) => setTimeout(r, name === "one" ? 20 : 0))
          order.push(`end:${name}`)
          return {}
        },
      }),
    )
    // Interleaving would put start:two before end:one.
    expect(order).toEqual(["start:one", "end:one", "start:two", "end:two"])
  })
})

describe("agent loop: failure paths", () => {
  it("nudges ONCE when a finished turn carries no revision block", async () => {
    // Models routinely describe the change instead of emitting it. One reminder recovers a
    // completed run; a second would just pay again for the same failure.
    const model = scripted([
      turn({ text: "I updated the roadmap: added Q3." }),
      turn({ text: revisionText("# Recovered") }),
    ])
    const out = await runAgentLoop(base({ callModel: model.callModel }))
    expect(out.ok && out.product.revision?.content).toBe("# Recovered")
    expect(JSON.stringify(model.seen[1]?.messages)).toContain("NOT accepted")
  })

  it("gives up after the nudge, and NOT retryably", async () => {
    // Deterministic: a model that ignored the contract twice ignores it a third time. Marking
    // this retryable would spend the owner's plan again for the identical answer.
    const model = scripted([turn({ text: "no block, sorry" })])
    const out = await runAgentLoop(base({ callModel: model.callModel }))
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.retryable).toBe(false)
    expect(out.turns).toBe(2) // the original turn plus the nudged one
  })

  it("a model-call failure IS retryable", async () => {
    // The expensive part has not happened yet, and a 429/5xx often succeeds on a second attempt.
    const out = await runAgentLoop(
      base({
        callModel: async () => {
          throw new Error("429 rate limited")
        },
      }),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.retryable).toBe(true)
    expect(out.error).toContain("429")
  })

  it("bounds a model that loops calling tools forever", async () => {
    // Without a ceiling a stuck run bills until the lease expires. Not retryable: a loop that
    // could not converge in maxTurns will not converge in another maxTurns.
    const model = scripted([turn({ toolUses: [{ id: "t", name: "x", input: {} }], done: false })])
    const out = await runAgentLoop(base({ callModel: model.callModel, maxTurns: 4 }))
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.turns).toBe(4)
    expect(out.retryable).toBe(false)
    expect(out.error).toMatch(/within 4 turns/)
    expect(DEFAULT_MAX_TURNS).toBeGreaterThan(1)
  })
})

describe("agent loop: cost", () => {
  it("accumulates across EVERY turn, including a run that ends in failure", async () => {
    // The budget sums what is reported, and a run that burned three turns producing nothing
    // still cost money. Reporting only the last turn would undercount exactly the runs that
    // went wrong — the same undercount the retry path had.
    const model = scripted([
      turn({ toolUses: [{ id: "t", name: "x", input: {} }], costUsd: 0.01, done: false }),
      turn({ toolUses: [{ id: "t", name: "x", input: {} }], costUsd: 0.02, done: false }),
      turn({ toolUses: [{ id: "t", name: "x", input: {} }], costUsd: 0.03, done: false }),
    ])
    const out = await runAgentLoop(base({ callModel: model.callModel, maxTurns: 3 }))
    expect(out.ok).toBe(false)
    expect(out.costUsd).toBeCloseTo(0.06, 6)
  })

  it("stays null when the provider reports nothing", async () => {
    // Null is UNKNOWN, never zero — the same distinction the run.cost_micro_usd column keeps, so
    // an unreported run cannot quietly look free.
    const out = await runAgentLoop(base({}))
    expect(out.costUsd).toBeNull()
  })
})

describe("agent loop: what it lets the model read", () => {
  const toolTurn = (id: string) => turn({ toolUses: [{ id, name: "read", input: {} }] })

  it("spends a tool-output budget ACROSS turns, not just per call", async () => {
    // The broker caps one result, which stops a single call blowing the window. It does not stop
    // twelve calls doing it together — which is what a run reading a corpus per turn does, and
    // what produced a 1,040,577-token prompt against a 1,048,576-token limit on a real cloud MCP.
    const model = scripted([
      toolTurn("t1"),
      toolTurn("t2"),
      toolTurn("t3"),
      toolTurn("t4"),
      turn({ text: revisionText() }),
    ])
    const huge = "x".repeat(150_000)
    const out = await runAgentLoop(
      base({ callModel: model.callModel, tools: [], executeTool: async () => huge }),
    )
    expect(out.ok).toBe(true)

    const delivered = JSON.stringify(model.seen[model.seen.length - 1]?.messages ?? [])
    // Four 150k reads would be 600k characters. The budget holds the total down, with headroom
    // for the envelope around each result.
    expect(delivered.length).toBeLessThan(TOOL_OUTPUT_BUDGET_CHARS + 20_000)
  })

  it("tells the model how much room is left, instead of only that it truncated", async () => {
    // A model told only "truncated" reasonably retries the same call with different arguments,
    // which is how a run spends its last turns re-reading what it cannot keep.
    const model = scripted([toolTurn("t1"), turn({ text: revisionText() })])
    await runAgentLoop(
      base({ callModel: model.callModel, executeTool: async () => "y".repeat(300_000) }),
    )
    const delivered = JSON.stringify(model.seen[1]?.messages ?? [])
    expect(delivered).toMatch(/truncated \d+ characters/)
    expect(delivered).toMatch(/Answer with what you have rather than calling again/)
  })

  it("withdraws the tools on the final turn, so they cannot be wasted", async () => {
    // The announcement is a request, and a model may ignore it — observed on a scheduled run
    // against a live cloud MCP, where some runs converged and some spent the last turn on a call
    // whose result is discarded, failing having paid for everything. With no tools offered, the
    // only move left is to answer.
    const model = scripted([toolTurn("t1"), toolTurn("t2"), turn({ text: revisionText() })])
    const out = await runAgentLoop(
      base({
        callModel: model.callModel,
        maxTurns: 3,
        tools: [{ name: "read", description: "d", params: { type: "object" } }],
        executeTool: async () => "ok",
      }),
    )
    expect(out.ok).toBe(true)
    // Offered on the early turns...
    expect((model.seen[0] as unknown as { tools: unknown[] }).tools ?? []).toHaveLength(1)
    // ...and withdrawn on the last.
    expect((model.seen[2] as unknown as { tools: unknown[] }).tools ?? []).toHaveLength(0)
  })

  it("announces the last turn instead of springing it", async () => {
    // A run guillotined at the cap has paid for every turn and produced nothing: the most
    // expensive way to fail, and the easiest to avoid.
    const model = scripted([
      toolTurn("t1"),
      toolTurn("t2"),
      toolTurn("t3"),
      turn({ text: revisionText() }),
    ])
    const out = await runAgentLoop(
      base({ callModel: model.callModel, maxTurns: 4, executeTool: async () => "ok" }),
    )
    expect(out.ok).toBe(true)
    const finalPrompt = JSON.stringify(model.seen[3]?.messages ?? [])
    expect(finalPrompt).toContain("This is your final turn")
    // And it is said ONCE, on the turn where it changes what to do — not every turn.
    expect(JSON.stringify(model.seen[1]?.messages ?? [])).not.toContain("final turn")
  })
})

import { describe, expect, it } from "vitest"
import { openAiCompatModel } from "../src/lib/model-openai"

// The OPENAI-COMPATIBLE adapter. Everything here is the mapping between the two wire formats,
// which is the only place a provider swap can go quietly wrong: a mangled request still gets a
// 200 back from some providers, and a mis-read response looks like "the model said nothing".
//
// `fetchImpl` is injected, so this runs with no key and no network.

const capture = () => {
  const seen: { url: string; init: RequestInit; body: Record<string, unknown> }[] = []
  const impl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init, body: JSON.parse(String(init.body)) })
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "hi there", tool_calls: [] }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as unknown as typeof fetch
  return { seen, impl }
}

const model = (impl: typeof fetch, baseUrl = "https://gw.example.com/v1") =>
  openAiCompatModel({
    apiKey: "k-123",
    baseUrl,
    model: "deepseek-ai/DeepSeek-V4-Flash",
    fetchImpl: impl,
  })

describe("the request it builds", () => {
  it("posts to /chat/completions with a bearer token", async () => {
    const { seen, impl } = capture()
    await model(impl)({ system: "be helpful", messages: [], tools: [] })
    expect(seen[0]?.url).toBe("https://gw.example.com/v1/chat/completions")
    expect((seen[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer k-123")
  })

  it("tolerates a trailing slash on the base url", async () => {
    // Pasting a URL with a trailing slash is the single most likely config typo, and it would
    // otherwise produce a //chat/completions that some gateways 404.
    const { seen, impl } = capture()
    await model(impl, "https://gw.example.com/v1/")({ system: "s", messages: [], tools: [] })
    expect(seen[0]?.url).toBe("https://gw.example.com/v1/chat/completions")
  })

  it("sends the system prompt as a MESSAGE, not a top-level field", async () => {
    // The difference that makes this a separate client rather than a base-url switch. Sent as a
    // top-level `system` (Anthropic's shape) it is silently ignored and the model loses its
    // instructions entirely.
    const { seen, impl } = capture()
    await model(impl)({
      system: "be helpful",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    })
    expect(seen[0]?.body.system).toBeUndefined()
    expect(seen[0]?.body.messages).toEqual([
      { role: "system", content: "be helpful" },
      { role: "user", content: "hello" },
    ])
  })

  it("flattens Anthropic-style content blocks into strings", async () => {
    // The loop builds assistant/tool turns as block arrays. Passed through unflattened they
    // arrive as objects the gateway rejects — or worse, as "[object Object]".
    const { seen, impl } = capture()
    await model(impl)({
      system: "s",
      messages: [
        { role: "assistant", content: [{ type: "text", text: "one" }] },
        { role: "user", content: [{ type: "tool_result", content: "rows: 3" }] },
      ],
      tools: [],
    })
    expect(seen[0]?.body.messages).toEqual([
      { role: "system", content: "s" },
      { role: "assistant", content: "one" },
      { role: "user", content: "rows: 3" },
    ])
  })

  it("maps tools to the function shape, and omits them entirely when there are none", async () => {
    const { seen, impl } = capture()
    await model(impl)({ system: "s", messages: [], tools: [] })
    expect(seen[0]?.body.tools).toBeUndefined()

    const withTools = capture()
    await model(withTools.impl)({
      system: "s",
      messages: [],
      tools: [{ name: "svc.read", description: "read", params: { type: "object" } }],
    })
    expect(withTools.seen[0]?.body.tools).toEqual([
      {
        type: "function",
        function: { name: "svc.read", description: "read", parameters: { type: "object" } },
      },
    ])
  })
})

describe("the response it reads", () => {
  const reply = (payload: unknown, status = 200) =>
    (async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch

  it("returns text and marks the turn done", async () => {
    const res = await model(
      reply({ choices: [{ message: { content: "the answer" }, finish_reason: "stop" }] }),
    )({ system: "s", messages: [], tools: [] })
    expect(res.text).toBe("the answer")
    expect(res.done).toBe(true)
    expect(res.toolUses).toEqual([])
  })

  it("parses tool calls, whose arguments arrive as a JSON STRING", async () => {
    // Anthropic hands back a parsed object; this format hands back a string. Forgetting to parse
    // it gives every tool a string where it expects args, which fails deep inside the tool.
    const res = await model(
      reply({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: "c1", function: { name: "svc.read", arguments: '{"q":"x"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    )({ system: "s", messages: [], tools: [] })
    expect(res.toolUses).toEqual([{ id: "c1", name: "svc.read", input: { q: "x" } }])
    expect(res.done).toBe(false)
    expect(res.text).toBe("")
  })

  it("survives malformed tool arguments rather than crashing the run", async () => {
    const res = await model(
      reply({
        choices: [
          {
            message: {
              tool_calls: [{ id: "c1", function: { name: "svc.read", arguments: "{oops" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    )({ system: "s", messages: [], tools: [] })
    // Empty input, and the tool reports its own failure back to the model — which the loop
    // already handles — instead of taking the whole run down here.
    expect(res.toolUses).toEqual([{ id: "c1", name: "svc.read", input: {} }])
  })

  it("THROWS on a non-2xx, so the loop can treat it as retryable", async () => {
    // Same contract as the Anthropic client: a 429 or 5xx has not spent the expensive part yet,
    // so it must surface as a thrown (retryable) error rather than an empty turn.
    await expect(
      model(reply({ error: "rate limited" }, 429))({ system: "s", messages: [], tools: [] }),
    ).rejects.toThrow(/model call failed \(429\)/)
  })

  it("reports cost as null rather than guessing a rate", async () => {
    const res = await model(reply({ choices: [{ message: { content: "x" } }] }))({
      system: "s",
      messages: [],
      tools: [],
    })
    expect(res.costUsd).toBeNull()
  })
})

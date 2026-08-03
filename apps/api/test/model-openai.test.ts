import { describe, expect, it, vi } from "vitest"
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

describe("routing preferences on a gateway that routes", () => {
  // OpenRouter serves one model id from a dozen backends whose generation speed differs by an
  // order of magnitude, so "which model" is only half the request. Measured on the incumbent
  // gateway: ~18 tokens/sec, which is what turned a three-call agent turn into half a minute.
  const send = async (extraBody?: Record<string, unknown>) => {
    let body: Record<string, unknown> | undefined
    const impl = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof fetch
    await openAiCompatModel({
      apiKey: "k",
      baseUrl: "https://gw.test/v1",
      model: "deepseek/deepseek-v4-flash-0731",
      fetchImpl: impl,
      ...(extraBody ? { extraBody } : {}),
    })({ system: "s", messages: [], tools: [] })
    return body
  }

  it("sends the provider order when one is configured", async () => {
    const body = await send({
      provider: { order: ["DeepInfra", "GMICloud"], allow_fallbacks: true },
    })
    expect(body?.provider).toEqual({ order: ["DeepInfra", "GMICloud"], allow_fallbacks: true })
    // and still the ordinary request
    expect(body?.model).toBe("deepseek/deepseek-v4-flash-0731")
  })

  it("sends NOTHING extra when unset, so a non-routing gateway sees no stray field", async () => {
    const body = await send()
    expect(body).not.toHaveProperty("provider")
  })

  it("never lets a routing field overwrite the request the adapter built", async () => {
    // A config typo must not be able to rewrite `messages` or `model` — routing is the caller's
    // business, the request shape is the adapter's.
    const body = await send({
      model: "someone-elses-model",
      messages: [],
      provider: { order: ["X"] },
    })
    expect(body?.model).toBe("deepseek/deepseek-v4-flash-0731")
    expect(body?.provider).toEqual({ order: ["X"] })
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

  it("THROWS on a truncated reply rather than pasting raw JSON as the answer", async () => {
    // The failure this prevents: a long document hits the ceiling mid-<revision>, the block has
    // no closing tag, the turn reads it as prose, and the user gets 30KB of JSON in a chat
    // bubble while the document is silently untouched.
    await expect(
      model(
        reply({
          choices: [
            { message: { content: '<revision>{"content":"# Half a doc' }, finish_reason: "length" },
          ],
        }),
      )({ system: "s", messages: [], tools: [] }),
    ).rejects.toThrow(/token ceiling/)
  })
})

// A TOOL CALL AND ITS RESULT MUST SURVIVE THE TRIP TO THE GATEWAY.
//
// The loop speaks Anthropic: after a tool call it appends the assistant's `toolUses`
// (`{id, name, input}`) as one message and the results (`{tool_use_id, content}`) as the next.
// Chat-completions wants `tool_calls` on the assistant turn and a separate `role: "tool"` message
// per result. Both blocks used to go through `flatten`, which matches on `type` — and neither
// carries one — so BOTH became "".
//
// The model therefore never saw that it had called a tool, nor what came back. It asked again,
// saw nothing, asked again, and the run died at the turn cap reporting "the agent did not produce
// a revision" — a conversation with its middle deleted, wearing the costume of a confused model.
// It broke every tool-using hosted run on any gateway deployment, for every kind of source.
describe("a tool call survives translation to chat-completions", () => {
  const capture = async () => {
    let sent: { messages: Record<string, unknown>[] } | undefined
    const call = openAiCompatModel({
      baseUrl: "https://gw.test/v1",
      apiKey: "k",
      model: "m",
      fetchImpl: (async (_u: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body))
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }) as unknown as typeof fetch,
    })
    await call({
      system: "s",
      messages: [
        { role: "user", content: "read the weather" },
        { role: "assistant", content: [{ id: "t1", name: "wx_get", input: { city: "London" } }] },
        { role: "user", content: [{ tool_use_id: "t1", content: '{"temperature_c":19.8}' }] },
      ] as never,
      tools: [{ name: "wx_get", description: "d", params: {} }],
    })
    return sent?.messages ?? []
  }

  it("the assistant turn carries tool_calls with JSON-STRING arguments", async () => {
    const assistant = (await capture()).find((m) => m.role === "assistant") as {
      tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[]
    }
    expect(assistant?.tool_calls).toHaveLength(1)
    expect(assistant?.tool_calls?.[0]?.id).toBe("t1")
    expect(assistant?.tool_calls?.[0]?.type).toBe("function")
    expect(assistant?.tool_calls?.[0]?.function.name).toBe("wx_get")
    // A STRING, not an object — the one detail that silently breaks a strict gateway.
    expect(assistant?.tool_calls?.[0]?.function.arguments).toBe('{"city":"London"}')
  })

  it("the result comes back as its own role:tool message, keyed to the call", async () => {
    const tool = (await capture()).find((m) => m.role === "tool")
    expect(tool).toBeTruthy()
    expect(tool?.tool_call_id).toBe("t1")
    expect(tool?.content).toBe('{"temperature_c":19.8}')
  })

  it("nothing is silently emptied — the regression that caused this", async () => {
    const msgs = await capture()
    // Before the fix BOTH of these were `{content: ""}`, and the model was left asking into a
    // void until the loop ran out of turns.
    expect(msgs.filter((m) => m.content === "")).toHaveLength(0)
    expect(JSON.stringify(msgs)).toContain("19.8")
  })
})

// ---- Streaming ------------------------------------------------------------
// `onDelta` is additive: without it the adapter must behave exactly as it always has, and with
// it the RETURNED ModelTurn must be identical to what the buffered path would have produced.
// That equivalence is the whole safety argument for streaming, so it is what these assert.

/** A fake SSE response built from raw `data:` frames, chunked at awkward boundaries on purpose. */
const sseResponse = (frames: string[], splitEvery = 7) => {
  const wire = frames.map((f) => `data: ${f}\n\n`).join("")
  const bytes = new TextEncoder().encode(wire)
  return new Response(
    new ReadableStream({
      start(controller) {
        // Deliberately split mid-frame so the reader's buffering is exercised, not bypassed.
        for (let i = 0; i < bytes.length; i += splitEvery)
          controller.enqueue(bytes.slice(i, i + splitEvery))
        controller.close()
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

const streamImpl = (frames: string[]) => {
  const seen: Record<string, unknown>[] = []
  const impl = (async (_url: string, init: RequestInit) => {
    seen.push(JSON.parse(String(init.body)))
    return sseResponse(frames)
  }) as unknown as typeof fetch
  return { seen, impl }
}

const textFrames = [
  JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }),
  JSON.stringify({ choices: [{ delta: { content: "lo, " } }] }),
  JSON.stringify({ choices: [{ delta: { content: "world" } }] }),
  JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { cost: 0.002 } }),
  "[DONE]",
]

describe("streaming", () => {
  it("does not ask for a stream when nobody is listening", async () => {
    const { seen, impl } = capture()
    await model(impl)({ system: "s", messages: [], tools: [] })
    expect(seen[0]?.body.stream).toBeUndefined()
  })

  it("asks for a stream (and usage) only when onDelta is passed", async () => {
    const { seen, impl } = streamImpl(textFrames)
    await model(impl)({ system: "s", messages: [], tools: [], onDelta: () => {} })
    expect(seen[0]?.stream).toBe(true)
    expect(seen[0]?.stream_options).toEqual({ include_usage: true })
  })

  it("emits text as it arrives, and returns the SAME reply the buffered path would", async () => {
    const got: string[] = []
    const { impl } = streamImpl(textFrames)
    const turn = await model(impl)({
      system: "s",
      messages: [],
      tools: [],
      onDelta: (t) => got.push(t),
    })
    expect(got).toEqual(["Hel", "lo, ", "world"])
    // The deltas are a view; the RETURN VALUE is the answer, and it is whole.
    expect(turn.text).toBe("Hello, world")
    expect(got.join("")).toBe(turn.text)
    expect(turn.done).toBe(true)
    expect(turn.costUsd).toBe(0.002)
  })

  it("reassembles tool calls split across frames, and never streams their fragments", async () => {
    const got: string[] = []
    const { impl } = streamImpl([
      JSON.stringify({ choices: [{ delta: { content: "checking" } }] }),
      JSON.stringify({
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "wx_get" } }] } },
        ],
      }),
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] } }],
      }),
      JSON.stringify({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"London"}' } }] } },
        ],
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      "[DONE]",
    ])
    const turn = await model(impl)({
      system: "s",
      messages: [],
      tools: [],
      onDelta: (t) => got.push(t),
    })
    // Only prose was streamed — a half-written JSON argument is not showable and never emitted.
    expect(got).toEqual(["checking"])
    expect(turn.toolUses).toEqual([{ id: "t1", name: "wx_get", input: { city: "London" } }])
    expect(turn.done).toBe(false)
  })

  it("still detects truncation, which streaming must not hide", async () => {
    const { impl } = streamImpl([
      JSON.stringify({ choices: [{ delta: { content: "half a doc" } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }),
      "[DONE]",
    ])
    await expect(
      model(impl)({ system: "s", messages: [], tools: [], onDelta: () => {} }),
    ).rejects.toThrow(/token ceiling/)
  })

  it("a listener that throws does not cost us the reply", async () => {
    const { impl } = streamImpl(textFrames)
    const turn = await model(impl)({
      system: "s",
      messages: [],
      tools: [],
      onDelta: () => {
        throw new Error("subscriber blew up")
      },
    })
    expect(turn.text).toBe("Hello, world")
  })

  it("skips a malformed frame instead of losing the rest of the reply", async () => {
    const got: string[] = []
    const { impl } = streamImpl([
      JSON.stringify({ choices: [{ delta: { content: "before" } }] }),
      "{not json at all",
      JSON.stringify({ choices: [{ delta: { content: "after" } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      "[DONE]",
    ])
    const turn = await model(impl)({
      system: "s",
      messages: [],
      tools: [],
      onDelta: (t) => got.push(t),
    })
    expect(got).toEqual(["before", "after"])
    expect(turn.text).toBe("beforeafter")
  })
})

describe("streaming failure modes", () => {
  it("a stream that just stops yields what arrived, and the contract above re-asks", async () => {
    // No finish_reason, no [DONE] — a gateway died, a proxy timed out, the last chunk was
    // dropped. The hand-rolled parser threw here. The SDK owns transport termination now, and at
    // its level this is INDISTINGUISHABLE from the [DONE]-only stream in the test below, which is
    // legal and has to keep working. Given that choice: tolerating a cut stream costs one
    // incomplete answer, while rejecting [DONE]-only streams would break every turn on exactly
    // the hand-rolled gateways this adapter exists to reach.
    //
    // The guard that carries the weight still holds — an EXPLICIT `length` throws (above). A
    // silently cut stream lands as an incomplete reply, which the revision contract rejects and
    // re-asks for, rather than as a finished document.
    const { impl } = streamImpl([
      JSON.stringify({ choices: [{ delta: { content: "Here is the fir" } }] }),
    ])
    const turn = await model(impl)({ system: "s", messages: [], tools: [], onDelta: () => {} })
    expect(turn.text).toBe("Here is the fir")
  })

  it("accepts a stream terminated by [DONE] alone", async () => {
    const { impl } = streamImpl([
      JSON.stringify({ choices: [{ delta: { content: "done properly" } }] }),
      "[DONE]",
    ])
    const turn = await model(impl)({ system: "s", messages: [], tools: [], onDelta: () => {} })
    expect(turn.text).toBe("done properly")
  })

  it("reads an event whose first line is not data: (event:/id:/comment)", async () => {
    // Spec-legal framing that a proxy or self-hosted gateway really does emit. Testing
    // startsWith on the whole frame dropped these silently and yielded an empty reply.
    const wire =
      `event: message\ndata: ${JSON.stringify({ choices: [{ delta: { content: "hello " } }] })}\n\n` +
      `id: 42\ndata: ${JSON.stringify({ choices: [{ delta: { content: "world" } }] })}\n\n` +
      `: keep-alive\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`
    const impl = (async () =>
      new Response(new TextEncoder().encode(wire), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch
    const turn = await model(impl)({ system: "s", messages: [], tools: [], onDelta: () => {} })
    expect(turn.text).toBe("hello world")
  })

  it("refuses an unaddressed tool-call fragment rather than stapling it onto another call", async () => {
    // Defaulting a missing index to 0 stapled one call's arguments onto another, so BOTH tools
    // then ran wrong: one with a foreign input, one with {}. The SDK is STRICTER than the parser
    // it replaces — a fragment that opens a call without an id is rejected outright — so the
    // turn now fails retryably instead of running two tools on wrong inputs. Same invariant,
    // enforced harder: arguments never land on a call that did not ask for them.
    const { impl } = streamImpl([
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "a" } }] } }],
      }),
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 1, id: "t2", function: { name: "b" } }] } }],
      }),
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ function: { arguments: '{"x":1}' } }] } }],
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      "[DONE]",
    ])
    await expect(
      model(impl)({ system: "s", messages: [], tools: [], onDelta: () => {} }),
    ).rejects.toThrow()
  })

  it("falls back to a buffered request when the gateway refuses to stream", async () => {
    // "OpenAI-compatible" is a wire format, not a guarantee: plenty of gateways 400 on the
    // unknown stream_options field. Streaming must never break a request that worked before.
    const bodies: Record<string, unknown>[] = []
    const impl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      bodies.push(body)
      if (body.stream) return new Response("unknown field stream_options", { status: 400 })
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "buffered reply" }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof fetch
    const turn = await model(impl)({ system: "s", messages: [], tools: [], onDelta: () => {} })
    expect(bodies).toHaveLength(2)
    expect(bodies[0]?.stream).toBe(true)
    expect(bodies[1]?.stream).toBeUndefined()
    expect(turn.text).toBe("buffered reply") // the person loses the animation, not the answer
  })

  it("gives up on a stream that opens, sends nothing, and never closes — and falls back", async () => {
    // The shape reproduced live against a real gateway (2026-08-03, PR #633): the connection
    // opens, the SDK's stream never yields another chunk, never fires onError, never resolves
    // stream.text/toolCalls/finishReason/finalStep — nothing. A `for await` over that hangs
    // forever with no error to catch, which is exactly what left a chat turn on "Working…" with
    // no answer and no failure. This must not depend on the model call's own abortSignal (120s)
    // actually firing against a given gateway; it is the backstop for when it does not.
    vi.useFakeTimers()
    try {
      const bodies: Record<string, unknown>[] = []
      const impl = (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        bodies.push(body)
        if (body.stream) {
          // Opens and never enqueues, never closes, never errors.
          return new Response(new ReadableStream({ start() {} }), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          })
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "buffered reply" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }) as unknown as typeof fetch
      const turnPromise = model(impl)({
        system: "s",
        messages: [],
        tools: [],
        onDelta: () => {},
      })
      // Past the model call's own 120s abort AND this file's 130s stream deadline — whichever
      // mechanism actually rescues it, the turn must settle rather than hang.
      await vi.advanceTimersByTimeAsync(131_000)
      const turn = await turnPromise
      expect(bodies).toHaveLength(2)
      expect(bodies[0]?.stream).toBe(true)
      expect(bodies[1]?.stream).toBeUndefined()
      expect(turn.text).toBe("buffered reply")
    } finally {
      vi.useRealTimers()
    }
  })

  it("parses a JSON answer even when it was asked to stream", async () => {
    // A gateway that ignores `stream` and replies with ordinary JSON. Parsing that as SSE finds
    // no data: frames and would produce a silent empty reply.
    const impl = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "plain json" }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch
    const turn = await model(impl)({ system: "s", messages: [], tools: [], onDelta: () => {} })
    expect(turn.text).toBe("plain json")
  })
})

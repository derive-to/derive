import { describe, expect, it } from "vitest"
import { openAiCompatModel } from "../../src/lib/model-openai"

/**
 * The model adapter, inside workerd. See vitest.worker.config.ts for what this lane does and does
 * not prove.
 *
 * WHY THIS LANE EXISTS FOR THIS FILE. The adapter used to be plain `fetch` and a hand-written SSE
 * reader precisely so it could not depend on anything Node-only — that was the whole argument for
 * owning ~420 lines of transport. Handing that to the AI SDK is only safe if the SDK holds the
 * same property, and "it should, it's isomorphic" is not something a Node test can check: the
 * failure mode is a dependency reaching for `node:*`, or a bundle that resolves a Node conditional
 * export, and both are green in Node and dead on deploy.
 *
 * Derive runs this API BOTH as a Node process (self-host) and as a Worker, so a regression here
 * breaks half the product silently. Streaming is exercised deliberately: it is the part that
 * touches Web Streams, TextDecoder and the eventsource parser, which is where a runtime
 * difference would actually surface.
 */

const sse = (frames: string[]) =>
  new Response(`${frames.map((f) => `data: ${f}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })

const model = (impl: typeof fetch) =>
  openAiCompatModel({
    apiKey: "k",
    baseUrl: "https://gw.example/v1",
    model: "test-model",
    fetchImpl: impl,
  })

describe("the gateway adapter runs in workerd", () => {
  it("is actually workerd, not Node wearing its name", async () => {
    // Without this the lane can silently degrade: a config regression that ran these tests under
    // Node would leave them green while proving nothing they claim to prove.
    expect(navigator.userAgent).toBe("Cloudflare-Workers")
  })

  it("completes a buffered turn", async () => {
    const impl = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "hello from the edge" }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch
    const turn = await model(impl)({ system: "s", messages: [], tools: [] })
    expect(turn.text).toBe("hello from the edge")
    expect(turn.done).toBe(true)
  })

  it("streams deltas through Web Streams, and returns the same reply", async () => {
    const impl = (async () =>
      sse([
        JSON.stringify({ choices: [{ delta: { content: "one " } }] }),
        JSON.stringify({ choices: [{ delta: { content: "two" } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      ])) as unknown as typeof fetch
    const seen: string[] = []
    const turn = await model(impl)({
      system: "s",
      messages: [],
      tools: [],
      onDelta: (t) => seen.push(t),
    })
    expect(seen.join("")).toBe("one two")
    expect(turn.text).toBe("one two")
  })

  it("reads a tool call, which is what every agent turn depends on", async () => {
    const impl = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "c1",
                    type: "function",
                    function: { name: "find", arguments: '{"q":"x"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch
    const turn = await model(impl)({
      system: "s",
      messages: [{ role: "user", content: "find x" }],
      tools: [{ name: "find", description: "find things", params: { type: "object" } }],
    })
    expect(turn.toolUses).toEqual([{ id: "c1", name: "find", input: { q: "x" } }])
    expect(turn.done).toBe(false)
  })
})

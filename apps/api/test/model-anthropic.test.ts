import { describe, expect, it } from "vitest"
import { anthropicModel, DEFAULT_ANTHROPIC_MODEL } from "../src/lib/model-anthropic"

/**
 * THE CLAUDE-PLAN LANE, which had no tests at all until it was moved onto the shared adapter.
 *
 * This is the path where a WORKSPACE's own credential spends a WORKSPACE's own money, so the two
 * things worth pinning are the ones that are silent when wrong: which header the credential rides
 * in (the wrong one 401s, and it has), and whether a turn is priced (an unpriced turn makes the
 * budget ceiling unreachable, and it did).
 */

const captured = () => {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v
    })
    calls.push({
      url: String(url),
      headers,
      body: JSON.parse(String(init?.body ?? "{}")),
    })
    return new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "answered" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as unknown as typeof fetch
  return { calls, impl }
}

describe("how a connected plan authenticates", () => {
  it("sends an API key as x-api-key", async () => {
    const { calls, impl } = captured()
    await anthropicModel({
      credential: { kind: "api_key", value: "sk-ant-key" },
      fetchImpl: impl,
    })({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [] })
    expect(calls[0]?.headers["x-api-key"]).toBe("sk-ant-key")
    expect(calls[0]?.headers.authorization).toBeUndefined()
  })

  it("sends a PLAN TOKEN as a bearer, with the beta opt-in and NO x-api-key", async () => {
    // The regression this exists for: a plan token — the DEFAULT option in the connect UI — sent
    // as x-api-key 401s every hosted run on that workspace, and the failure looks like a bad
    // credential rather than a bad mapping.
    const { calls, impl } = captured()
    await anthropicModel({
      credential: { kind: "oauth", value: "plan-token" },
      fetchImpl: impl,
    })({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [] })
    expect(calls[0]?.headers.authorization).toBe("Bearer plan-token")
    expect(calls[0]?.headers["anthropic-beta"]).toContain("oauth-2025-04-20")
    // Load-bearing: the provider sets x-api-key by default, and leaving it on sends the plan
    // token in a header that rejects it.
    expect(calls[0]?.headers["x-api-key"]).toBeUndefined()
  })

  it("talks to an ANTHROPIC model id, never the gateway's", async () => {
    // Handing this client the deploy-level gateway model name 404s `model_not_found` on every
    // hosted run — and DEPLOY.md tells operators to set that name.
    const { calls, impl } = captured()
    await anthropicModel({ credential: { kind: "api_key", value: "k" }, fetchImpl: impl })({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    })
    expect((calls[0]?.body as { model: string }).model).toBe(DEFAULT_ANTHROPIC_MODEL)
  })

  it("hits api.anthropic.com even when ANTHROPIC_BASE_URL is set in the process environment", async () => {
    // createAnthropic reads ANTHROPIC_BASE_URL unless baseURL is pinned. A local Claude proxy,
    // CI harness, or self-host rewrite would otherwise steer every plan-token turn off the
    // Messages API the connected credential is for — and the intercept in substrate-loop's
    // credential tests (which keys on api.anthropic.com) would go silent the same way.
    const prev = process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9"
    try {
      const { calls, impl } = captured()
      await anthropicModel({ credential: { kind: "api_key", value: "k" }, fetchImpl: impl })({
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      })
      expect(calls[0]?.url).toMatch(/^https:\/\/api\.anthropic\.com\//)
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL
      else process.env.ANTHROPIC_BASE_URL = prev
    }
  })
})

describe("what a plan turn reports", () => {
  it("prices a known model from its own rate table", async () => {
    // 1M in + 1M out on Sonnet = $3 + $15. Unpriced turns are why the budget ceiling was
    // unreachable for every workspace before the table existed.
    const { impl } = captured()
    const turn = await anthropicModel({
      credential: { kind: "api_key", value: "k" },
      fetchImpl: impl,
    })({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [] })
    expect(turn.costUsd).toBeCloseTo(18, 5)
    expect(turn.text).toBe("answered")
    expect(turn.done).toBe(true)
  })

  it("reports cost as UNKNOWN for a model it has no rate for, rather than guessing", async () => {
    const { impl } = captured()
    const turn = await anthropicModel({
      credential: { kind: "api_key", value: "k" },
      model: "claude-something-unreleased",
      fetchImpl: impl,
    })({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [] })
    expect(turn.costUsd).toBeNull()
  })

  it("never streams, whatever the caller passes", async () => {
    // The contract allows an adapter not to stream; what it does not allow is calling onDelta
    // and then answering differently from what was streamed.
    const { calls, impl } = captured()
    const seen: string[] = []
    const turn = await anthropicModel({
      credential: { kind: "api_key", value: "k" },
      fetchImpl: impl,
    })({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      onDelta: (t) => seen.push(t),
    })
    expect(seen).toEqual([])
    expect(turn.text).toBe("answered")
    expect((calls[0]?.body as { stream?: boolean }).stream).toBeFalsy()
  })
})

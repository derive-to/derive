import { describe, expect, it } from "vitest"
import { ComposioBroker } from "../src/composio"
import { McpBroker } from "../src/mcp"

// Every broker's HTTP call must invoke its fetch implementation as a PLAIN FUNCTION.
//
// This is a production-only failure that no ordinary test can see. `private readonly fetchImpl:
// typeof fetch = fetch` stores the runtime's global fetch on the instance, so `this.fetchImpl(…)`
// calls it with the broker as its `this`. Node's undici shrugs; workerd throws
// "Illegal invocation: function called with incorrect `this` reference" — so in a deployed
// Worker EVERY brokered request failed, and `connect` dutifully reported the server as
// unreachable. A whole feature that passes its entire suite and reaches nothing.
//
// Reproduced here by making `this` observable: a `function` (not an arrow — arrows take `this`
// lexically and would pass no matter what the code does) called bare in a strict-mode module
// sees `this === undefined`, and called as a method sees the object. That is exactly the
// distinction workerd enforces, so this fails against the old code and passes against the fix.
//
// AND YES, THE OBVIOUS FIX WAS TRIED. Running this package under @cloudflare/vitest-pool-workers
// (the repo already uses it for the D1 lane) does NOT catch this: inside the pool the global
// `fetch` is `async (input, init) => {…}`, a JavaScript shim rather than the native builtin, and a
// shim has no `this` check to fail. Measured, with the fix reverted — three tests, real workerd,
// all green. "Tested in workerd" is not the same claim as "works in a deployed Worker", so a
// workerd lane was removed again rather than left to assert coverage that is not there. The
// deployed Worker, and `wrangler dev`, do enforce it.

const strictFetch = (onCall: (body: unknown) => unknown) =>
  function (this: unknown, _input: string | URL | Request, init?: RequestInit) {
    // The one assertion that matters. workerd checks this for real.
    if (this !== undefined)
      throw new TypeError(
        "Illegal invocation: function called with incorrect `this` reference. " +
          `Got ${Object.prototype.toString.call(this)}.`,
      )
    const body = JSON.parse(String(init?.body ?? "{}")) as { id?: number }
    return Promise.resolve(
      new Response(JSON.stringify(onCall(body)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
  } as unknown as typeof fetch

describe("brokers call fetch as a plain function (workerd `this` rule)", () => {
  it("McpBroker reaches a server instead of throwing Illegal invocation", async () => {
    const fetchImpl = strictFetch((body) => ({
      jsonrpc: "2.0",
      id: (body as { id: number }).id,
      result: {
        tools: [{ name: "get_current_weather", description: "weather", inputSchema: {} }],
        protocolVersion: "2025-11-25",
      },
    }))
    const link = await new McpBroker(fetchImpl).connect({
      orgId: "o1",
      userId: "u1",
      toolkit: "https://example.com/mcp",
    })
    // Under the old code this was `pending` — the broker's own report of an unreachable server,
    // which is precisely how the bug disguised itself in production.
    expect(link.status).toBe("active")
    expect(link.ref).toContain("s256-")
  })

  it("ComposioBroker likewise", async () => {
    const fetchImpl = strictFetch(() => ({ items: [] }))
    await expect(new ComposioBroker("key", fetchImpl).toolsFor(["conn_1"])).resolves.toBeInstanceOf(
      Array,
    )
  })
})

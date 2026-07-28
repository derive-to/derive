import { describe, expect, it } from "vitest"
import type { Sandbox } from "../src/lib/code-sandbox"

/**
 * THE SANDBOX CONTRACT — one behavioural suite every implementation must pass.
 *
 * Mirrors packages/db/test/store-contract.ts, and for the same reason: there are two
 * implementations of one idea (a Node worker thread, a Cloudflare dynamic isolate), and what
 * keeps them honest is a shared SUITE rather than a shared description. Code written against one
 * has to behave identically on the other, or `derive_code` quietly means something different
 * depending on where a workspace happens to run.
 *
 * The isolation mechanics genuinely differ, and should: Node needs an in-context prelude to close
 * the `constructor.constructor` escape, while Workers disallows `eval` outright and never had
 * that hole. What must NOT differ is anything visible to the code being run — the `tools`
 * surface, `call_tool`, `console.log`, what `return` does, the shape of a failure, and every
 * limit. Everything below is one of those.
 *
 * Adversarial cases first, because this runs text a model wrote and that model may have read a
 * hostile page.
 */
export function runSandboxContract(label: string, make: () => Sandbox): void {
  const run = (
    code: string,
    opts: Partial<{ tools: Record<string, unknown>; timeoutMs: number }> = {},
  ) => {
    const calls: { name: string; args: unknown }[] = []
    const table = opts.tools ?? { echo: (a: unknown) => ({ echoed: a }) }
    return make()
      .run({
        code,
        timeoutMs: opts.timeoutMs ?? 10_000,
        host: {
          toolNames: Object.keys(table),
          callTool: async (name, args) => {
            calls.push({ name, args })
            const fn = table[name] as ((a: unknown) => unknown) | undefined
            if (!fn) throw new Error(`unknown tool: ${name}`)
            return fn(args)
          },
        },
      })
      .then((r) => ({ ...r, calls }))
  }

  describe(`${label}: it runs code`, () => {
    it("returns a value", async () => {
      const r = await run(`return 6 * 7`)
      expect(r.error).toBeUndefined()
      expect(r.value).toBe(42)
    })

    it("calls tools and composes their results — the whole point", async () => {
      // One approval, several operations. This is what makes a dozen tool prompts into one.
      const r = await run(
        `const a = await tools.list({ q: "x" })
       const b = await tools.get({ id: a.ids[0] })
       return { count: a.ids.length, title: b.title }`,
        {
          tools: {
            list: () => ({ ids: ["i1", "i2", "i3"] }),
            get: (a: unknown) => ({ title: `art ${(a as { id: string }).id}` }),
          },
        },
      )
      expect(r.value).toEqual({ count: 3, title: "art i1" })
      expect(r.calls.map((c) => c.name)).toEqual(["list", "get"])
    })

    it("captures console.log in order", async () => {
      const r = await run(`console.log("one"); console.log({ two: 2 }); return null`)
      expect(r.logs).toEqual(["one", '{"two":2}'])
    })

    it("reports a thrown error instead of crashing the host", async () => {
      const r = await run(`throw new Error("boom")`)
      expect(r.error).toContain("boom")
      expect(r.value).toBeNull()
    })

    it("a failing tool comes back as a VALUE the code can handle", async () => {
      // So a composed script can survive one dead source rather than losing the calls that
      // already succeeded.
      const r = await run(
        `const out = await tools.bad({})
       return { sawError: typeof out.error === "string" }`,
        {
          tools: {
            bad: () => {
              throw new Error("upstream 503")
            },
          },
        },
      )
      expect(r.value).toEqual({ sawError: true })
    })
  })

  describe(`${label}: the canonical surface`, () => {
    // The names in packages/core/src/agent-surface.ts, asserted rather than assumed. They are the
    // same names the CONTAINER path binds, so code an agent writes in one place runs in the other
    // — which is the whole reason that file exists.
    it("binds tools, call_tool and console", async () => {
      const r = await run(
        `return { tools: typeof tools, call_tool: typeof call_tool, log: typeof console.log }`,
      )
      expect(r.value).toEqual({ tools: "object", call_tool: "function", log: "function" })
    })

    it("call_tool reaches a tool by a name computed at runtime", async () => {
      // The escape hatch for a name the code assembles — indexing `tools` covers the literal
      // case, this covers the rest.
      const r = await run(`const n = "ec" + "ho"; return (await call_tool(n, { a: 1 })).echoed.a`)
      expect(r.value).toBe(1)
    })

    it("returns a string as-is rather than quoted", async () => {
      // The common case is a summary line; quoting it would make every caller strip quotes.
      const r = await run(`return "done"`)
      expect(r.value).toBe("done")
    })
  })

  describe(`${label}: it holds`, () => {
    it("cannot read the environment — no secrets to take", async () => {
      // THE property. The worker is spawned with env: {}, so even a full escape finds nothing.
      const r = await run(
        `try { return { keys: Object.keys(process.env).length } } catch (e) { return { threw: true } }`,
      )
      // Either `process` is undefined (threw) or the env is genuinely empty. Both are pass.
      expect(r.error ?? JSON.stringify(r.value)).toMatch(/threw|"keys":0|undefined/)
    })

    it("cannot reach require, and so cannot reach the filesystem or network", async () => {
      const r = await run(
        `try { const fs = require("node:fs"); return "GOT REQUIRE" } catch { return "no require" }`,
      )
      expect(r.value).not.toBe("GOT REQUIRE")
    })

    it("closes the constructor.constructor escape out of the vm realm", async () => {
      // The classic Node-vm escape: any host-created object exposes a path to the host `Function`,
      // and from there to `process` and `require`. The prelude keeps bridges and results in-realm
      // and shadows Function, so this must not yield a working host constructor.
      const r = await run(
        `try {
         const res = await tools.echo({ a: 1 })
         const F = res.constructor.constructor
         return { escaped: typeof F("return process")() !== "undefined" }
       } catch (e) { return { escaped: false, why: String(e).slice(0, 60) } }`,
      )
      expect((r.value as { escaped: boolean })?.escaped ?? false).toBe(false)
    })

    it("cannot call a tool it was not given", async () => {
      // The tool surface is built from the host's list, and the host re-checks by name — the code
      // can only do what the caller could already do by hand.
      const r = await run(`return typeof tools.secret_admin_tool`)
      expect(r.value).toBe("undefined")
    })

    it("terminates a runaway synchronous loop", async () => {
      const r = await run(`while (true) {}`, { timeoutMs: 1_500 })
      expect(r.error).toBeTruthy()
    })

    it("terminates a promise that never settles", async () => {
      // The case an inner vm timeout alone does NOT catch: it bounds synchronous work only, so
      // without a host-side wall clock this hangs the request forever.
      const r = await run(`await new Promise(() => {}); return "unreachable"`, { timeoutMs: 1_500 })
      expect(r.error).toMatch(/timed out/)
      expect(r.value).toBeNull()
    })

    it("bounds a flood of logs rather than returning them all", async () => {
      const r = await run(`for (let i = 0; i < 5000; i++) console.log("x" + i); return "done"`)
      expect(r.logs.length).toBeLessThanOrEqual(200)
    })

    it("truncates an oversized return value", async () => {
      // Returning a megabyte of JSON is the problem code mode exists to solve, not a feature.
      const r = await run(`return "x".repeat(200000)`)
      expect(JSON.stringify(r.value)).toContain("truncated")
    })
  })
}

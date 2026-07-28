import { execFile } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { TOOL_MODULE_SRC, writeToolShim } from "../src/runner.js"

// CODE MODE — the generated module a run's agent composes tools with.
//
// Tested by GENERATING it and RUNNING it, in a child process, against a stub tool endpoint. A
// test that only asserted on the generated text would pass while emitting JavaScript that does
// not parse or does not talk to the right URL, which is the entire risk of shipping code as a
// string.
//
// The composed case is the point: two calls joined in ONE script, printing only the answer.
// That is what the one-call-per-spawn shim could not do, and it is why intermediate results stop
// crossing the model's context window.

let server
let port
const received = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => {
      body += c
    })
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}")
      received.push({ url: req.url, auth: req.headers.authorization, ...parsed })
      if (parsed.tool === "boom") {
        res.writeHead(502, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: "tool exploded" }))
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: { echo: parsed.args, tool: parsed.tool } }))
    })
  })
  await new Promise((r) => server.listen(0, r))
  port = server.address().port
})
afterAll(() => server?.close())

const generate = (tools) => {
  const cwd = mkdtempSync(join(tmpdir(), "derive-codemode-test-"))
  writeToolShim(cwd, tools)
  return cwd
}
// ASYNC exec, deliberately. execFileSync blocks this process's event loop — and the stub tool
// server runs in THIS process, so a synchronous spawn deadlocks: the child's fetch can never be
// answered. Cost an hour the first time; the symptom is a test that hangs with no output.
const execFileAsync = promisify(execFile)
const run = async (cwd, script, runId = "run_1") => {
  writeFileSync(join(cwd, "task.mjs"), script)
  const { stdout } = await execFileAsync("node", ["task.mjs"], {
    cwd,
    env: {
      ...process.env,
      DERIVE_SERVER: `http://localhost:${port}`,
      DERIVE_TOKEN: "tok-abc",
      DERIVE_RUN_ID: runId,
    },
    encoding: "utf8",
  })
  return stdout.trim()
}

/** ONE-COMMAND mode: `node derive-sources.mjs -e '<code>'`, nothing written to disk. */
const evalOne = async (cwd, code, runId = "run_1") => {
  const { stdout } = await execFileAsync("node", ["derive-sources.mjs", "-e", code], {
    cwd,
    env: {
      ...process.env,
      DERIVE_SERVER: `http://localhost:${port}`,
      DERIVE_TOKEN: "tok-abc",
      DERIVE_RUN_ID: runId,
    },
    encoding: "utf8",
  })
  return stdout.trim()
}

describe("code mode: the generated tool module", () => {
  it("writes BOTH the one-shot CLI and the composable module", () => {
    // Keeping the CLI means an agent that ignores the module still works exactly as before:
    // this is an addition to what the executor can do, never a change to what it must do.
    const cwd = generate(["svc.read"])
    expect(readFileSync(join(cwd, "derive-source.mjs"), "utf8")).toContain("process.argv")
    expect(readFileSync(join(cwd, "derive-sources.mjs"), "utf8")).toContain("export const sources")
  })

  it("COMPOSES two tools in one script and proxies both through the run endpoint", async () => {
    const cwd = generate(["svc.list", "svc.get"])
    const out = await run(
      cwd,
      `import { sources } from "./derive-sources.mjs"
       const a = await sources["svc.list"]({ q: "x" })
       const b = await sources["svc.get"]({ id: a.echo.q + "-1" })
       console.log(JSON.stringify({ first: a.tool, second: b.tool, joined: b.echo.id }))`,
    )
    expect(JSON.parse(out)).toEqual({ first: "svc.list", second: "svc.get", joined: "x-1" })
    // Both calls went through the RUN's endpoint with the run's bearer — the property that keeps
    // credentials out of the model process and lets the server stamp taint per call.
    const mine = received.filter((r) => r.url === "/v1/agent/runs/run_1/tool")
    expect(mine.map((r) => r.tool)).toEqual(["svc.list", "svc.get"])
    expect(new Set(mine.map((r) => r.auth))).toEqual(new Set(["Bearer tok-abc"]))
  })

  it("only names tools the run is allowed to call", () => {
    // Ergonomics, not the boundary — the server re-checks every call — but a module listing a
    // tool the run cannot use would invite the model to waste turns on guaranteed 403s.
    const src = TOOL_MODULE_SRC(["svc.read"])
    expect(src).toContain('"svc.read"')
    expect(src).not.toContain("other.write")
  })

  it("surfaces a failing tool as a thrown Error the script can catch", async () => {
    // A composed script must be able to handle one dead source and still finish, rather than
    // dying and losing the work of the calls that succeeded.
    const cwd = generate(["boom", "svc.get"])
    const out = await run(
      cwd,
      `import { sources } from "./derive-sources.mjs"
       let caught = null
       try { await sources["boom"]({}) } catch (e) { caught = e.message }
       const ok = await sources["svc.get"]({ id: "still-works" })
       console.log(JSON.stringify({ caught: caught.includes("502"), recovered: ok.echo.id }))`,
      "run_1",
    )
    expect(JSON.parse(out)).toEqual({ caught: true, recovered: "still-works" })
  })

  it("generates valid JS even with no tools", async () => {
    // A run can be bound to a connection that currently exposes nothing (a pinned MCP server
    // that changed). The module must still parse, or the whole run dies on import.
    const cwd = generate([])
    expect(
      await run(cwd, `import s from "./derive-sources.mjs"; console.log(Object.keys(s).length)`),
    ).toBe("0")
  })
})

describe("code mode: one-command mode", () => {
  it("composes two tools in ONE invocation with no file written", async () => {
    // The ergonomics that decide whether this gets used. Telling an agent to write a script and
    // then run it is two actions — and in a supervised session, two approval prompts — for one
    // step. A single command with `sources` already in scope is one of each.
    const cwd = generate(["svc.list", "svc.get"])
    const before = readdirSync(cwd).sort()
    const out = await evalOne(
      cwd,
      `const a = await sources["svc.list"]({ q: "x" })
       const b = await sources["svc.get"]({ id: a.echo.q + "-1" })
       return { joined: b.echo.id, second: b.tool }`,
    )
    expect(JSON.parse(out)).toEqual({ joined: "x-1", second: "svc.get" })
    // Nothing new on disk: the agent never had to author a file.
    expect(readdirSync(cwd).sort()).toEqual(before)
  })

  it("a returned object is JSON-stringified, and console.log still works", async () => {
    const cwd = generate(["svc.a"])
    expect(await evalOne(cwd, `return { ok: 1 }`)).toBe('{"ok":1}')
    expect(await evalOne(cwd, `console.log("plain"); `)).toBe("plain")
    // A returned string is printed as-is rather than quoted — the common case is a summary line.
    expect(await evalOne(cwd, `return "done"`)).toBe("done")
  })

  it("reports a failing tool on stderr and exits nonzero", async () => {
    // The executor reads exit codes. A silent failure would look like an empty result.
    const cwd = generate(["boom"])
    await expect(evalOne(cwd, `return await sources["boom"]({})`)).rejects.toThrow()
  })
})

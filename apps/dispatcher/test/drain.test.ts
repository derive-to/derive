import { spawn } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { type DispatcherConfig, loadDispatcherConfig } from "../src/config"
import { drainArgs, runDrain } from "../src/drain"

// A stand-in runner: a real spawned Node script, so the drain path is tested
// with genuine process lifecycle (exit codes, output capture, kill-on-timeout)
// and zero model or server involvement.
const stubRunner = (body: string): string => {
  const f = join(mkdtempSync(join(tmpdir(), "drain-stub-")), "stub.mjs")
  writeFileSync(f, body)
  return f
}

// Route the spawn at the stub script under the real Node binary, preserving the
// dispatcher-built opts (cwd, env, stdio) so those stay under test.
const viaStub = (stub: string) => (_cmd: string, _args: string[], opts: object) =>
  spawn(process.execPath, [stub], opts)

const cfgWith = (over: NodeJS.ProcessEnv = {}) =>
  loadDispatcherConfig({
    DATABASE_URL: "postgres://x/y",
    DISPATCHER_CONTEXTS: JSON.stringify([{ id: "ctx_a", token_env: "T", model: "opus" }]),
    DISPATCHER_DATA_DIR: mkdtempSync(join(tmpdir(), "drain-data-")),
    ...over,
  })

const one = (cfg: DispatcherConfig) => {
  const c = cfg.contexts[0]
  if (!c) throw new Error("empty registry in test")
  return c
}

describe("drainArgs", () => {
  it("builds the runner invocation: once, context, server, optional model", () => {
    const cfg = cfgWith({ DERIVE_SERVER: "http://localhost:8080/" })
    expect(drainArgs(cfg, one(cfg))).toEqual([
      "runner",
      "once",
      "ctx_a",
      "--server",
      "http://localhost:8080",
      "--model",
      "opus",
    ])
  })
})

describe("runDrain", () => {
  it("captures a clean exit with the output tail", async () => {
    const stub = stubRunner(`console.log("[runner] drain complete — 2 served, 0 failed")`)
    const cfg = cfgWith()
    const r = await runDrain(cfg, one(cfg), "tok", viaStub(stub))
    expect(r.ok).toBe(true)
    expect(r.code).toBe(0)
    expect(r.tail).toContain("2 served")
  })

  it("a nonzero exit is a failed drain, tail preserved", async () => {
    const stub = stubRunner(
      `console.error("error: context has no readable manifest");process.exit(1)`,
    )
    const cfg = cfgWith()
    const r = await runDrain(cfg, one(cfg), "tok", viaStub(stub))
    expect(r.ok).toBe(false)
    expect(r.code).toBe(1)
    expect(r.tail).toContain("no readable manifest")
  })

  it("kills a hung drain at the deadline", async () => {
    const stub = stubRunner(`setInterval(() => {}, 1000)`)
    const cfg = cfgWith({ DISPATCHER_DRAIN_TIMEOUT_MS: "300" })
    const r = await runDrain(cfg, one(cfg), "tok", viaStub(stub))
    expect(r.ok).toBe(false)
    expect(r.signal).toBe("SIGTERM")
  }, 10_000)

  it("a missing runner binary surfaces as a failed drain, not an unhandled error", async () => {
    const cfg = cfgWith({ DISPATCHER_RUNNER_BIN: "/nope/derive-not-here" })
    const r = await runDrain(cfg, one(cfg), "tok")
    expect(r.ok).toBe(false)
    expect(r.tail).toContain("spawn failed")
  })
})

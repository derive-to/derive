import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { type DispatcherConfig, loadDispatcherConfig, resolveToken } from "../src/config"

const BASE = { DATABASE_URL: "postgres://x/y" }
const ctx = (over: object = {}) => JSON.stringify([{ id: "ctx_a", token_env: "CTX_A", ...over }])
// Strict indexed access makes contexts[0] possibly-undefined; the tests always
// build a one-entry registry, so reach through a throwing accessor.
const one = (cfg: DispatcherConfig) => {
  const c = cfg.contexts[0]
  if (!c) throw new Error("empty registry in test")
  return c
}

describe("loadDispatcherConfig", () => {
  it("parses an inline registry with defaults, and a wrapped { contexts } form", () => {
    const cfg = loadDispatcherConfig({ ...BASE, DISPATCHER_CONTEXTS: ctx() })
    expect(cfg.contexts).toEqual([
      { id: "ctx_a", tokenEnv: "CTX_A", tokenFile: null, model: null, cron: "* * * * *" },
    ])
    expect(cfg.server).toBe("https://derive.to") // cloud default, like the CLI
    expect(cfg.runnerBin).toBe("derive")
    const wrapped = loadDispatcherConfig({
      ...BASE,
      DISPATCHER_CONTEXTS: JSON.stringify({ contexts: JSON.parse(ctx()) }),
    })
    expect(wrapped.contexts).toHaveLength(1)
  })

  it("reads the registry from a file when not inline", () => {
    const f = join(mkdtempSync(join(tmpdir(), "disp-")), "contexts.json")
    writeFileSync(f, ctx({ cron: "*/5 * * * *", model: "opus" }))
    const cfg = loadDispatcherConfig({ ...BASE, DISPATCHER_CONTEXTS_FILE: f })
    expect(cfg.contexts[0]).toMatchObject({ cron: "*/5 * * * *", model: "opus" })
  })

  it("refuses an inline token — the registry never holds secrets", () => {
    expect(() =>
      loadDispatcherConfig({
        ...BASE,
        DISPATCHER_CONTEXTS: JSON.stringify([{ id: "ctx_a", token: "dk_agt_leak" }]),
      }),
    ).toThrow(/never holds secrets/)
  })

  it("requires a registry, a token source, and a 5-field cron — but NOT a database", () => {
    // No DATABASE_URL: the schedule is an in-process clock now (pg-boss is gone), and the only
    // queue of record is Derive's own tables behind the API. This process persists nothing.
    expect(() => loadDispatcherConfig({ DISPATCHER_CONTEXTS: ctx() })).not.toThrow()
    expect(() => loadDispatcherConfig({ ...BASE })).toThrow(/DISPATCHER_CONTEXTS/)
    expect(() =>
      loadDispatcherConfig({ ...BASE, DISPATCHER_CONTEXTS: JSON.stringify([{ id: "c" }]) }),
    ).toThrow(/token_env/)
    expect(() =>
      loadDispatcherConfig({ ...BASE, DISPATCHER_CONTEXTS: ctx({ cron: "hourly" }) }),
    ).toThrow(/cron/)
  })

  it("rejects a duplicated context id", () => {
    const two = JSON.stringify([
      { id: "ctx_a", token_env: "A" },
      { id: "ctx_a", token_env: "B" },
    ])
    expect(() => loadDispatcherConfig({ ...BASE, DISPATCHER_CONTEXTS: two })).toThrow(/twice/)
  })
})

describe("resolveToken", () => {
  it("resolves from the named env var and from a token file, trimmed", () => {
    const cfg = loadDispatcherConfig({ ...BASE, DISPATCHER_CONTEXTS: ctx() })
    expect(resolveToken(one(cfg), { CTX_A: " dk_agt_x \n" })).toBe("dk_agt_x")
    const f = join(mkdtempSync(join(tmpdir(), "disp-")), "tok")
    writeFileSync(f, "dk_agt_file\n")
    const fileCfg = loadDispatcherConfig({
      ...BASE,
      DISPATCHER_CONTEXTS: JSON.stringify([{ id: "ctx_b", token_file: f }]),
    })
    expect(resolveToken(one(fileCfg), {})).toBe("dk_agt_file")
  })

  it("an unset env var or empty file fails loudly, naming the source", () => {
    const cfg = loadDispatcherConfig({ ...BASE, DISPATCHER_CONTEXTS: ctx() })
    expect(() => resolveToken(one(cfg), {})).toThrow(/CTX_A/)
  })
})

import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { codex } from "../src/providers/codex.js"
import {
  configForRun,
  loadRunnerConfig,
  resolveModelEnv,
  runAgent,
  stripModelTokens,
} from "../src/runner.js"

describe("provider registry", () => {
  it("an unknown provider is fatal for a real run but degrades to a finding under partial (doctor)", () => {
    // A real run must fail loudly rather than silently pick a different agent.
    expect(() =>
      loadRunnerConfig({ RUNNER_PROVIDER: "nope", DERIVE_TOKEN: "t", DERIVE_CONTEXT: "c" }, {}),
    ).toThrow(/unknown provider "nope"/)
    // doctor (partial) must survive a bad config and report it, not crash: the
    // name is preserved so doctor can flag it, and defaults fall back sanely.
    const cfg = loadRunnerConfig({ RUNNER_PROVIDER: "nope" }, {}, { partial: true })
    expect(cfg.providerName).toBe("nope")
    expect(cfg.model).toBe("sonnet")
    expect(cfg.agentBin).toBe("claude")
  })
})

describe("runAgent is provider-agnostic", () => {
  // A pure-JS provider: no subprocess, just canned results. If the orchestration
  // is truly agnostic, the claude-only retry/salvage behavior works here too.
  const fake = (script) => {
    const calls = []
    return {
      calls,
      name: "fake",
      run: async (opts) => {
        calls.push(opts)
        return {
          timedOut: false,
          code: 0,
          sessionId: null,
          stderr: "",
          lastText: "",
          isError: false,
          apiErrorStatus: null,
          resultText: "",
          ...script(calls.length),
        }
      },
      retryable: (r) => r.code !== 0 && !r.timedOut,
    }
  }
  const opts = (provider) => ({
    provider,
    bin: "x",
    cwd: tmpdir(),
    model: "m",
    timeoutMs: 30_000,
    systemPrompt: "sys",
    prompt: "task",
    retryDelayMs: 0,
  })

  it("returns the parsed answer and appends the <answer> contract to the system prompt", async () => {
    const p = fake(() => ({ resultText: '<answer>{"body_md":"hi"}</answer>' }))
    const out = await runAgent(p, opts())
    expect(out).toEqual({ ok: true, answer: expect.objectContaining({ body_md: "hi" }) })
    // The runner, not the provider, carries the output contract.
    expect(p.calls[0].systemPrompt).toContain("sys")
    expect(p.calls[0].systemPrompt).toContain("<answer>")
    expect(p.calls[0].resumeSessionId).toBeNull()
  })

  it("retries a retryable failure, resuming the session the provider returned", async () => {
    const p = fake((n) =>
      n === 1
        ? { code: 1, sessionId: "sess-9", resultText: "" }
        : { resultText: '<answer>{"body_md":"ok"}</answer>' },
    )
    const out = await runAgent(p, opts())
    expect(out.ok).toBe(true)
    expect(p.calls).toHaveLength(2)
    expect(p.calls[1].resumeSessionId).toBe("sess-9")
  })

  it("salvages substantive output that never produced a block", async () => {
    const p = fake(() => ({ resultText: "prose, no block", sessionId: "s1" }))
    const out = await runAgent(p, opts())
    expect(out.ok).toBe(true)
    expect(out.answer.body_md).toBe("prose, no block")
    expect(out.answer.caveats[0]).toMatch(/couldn't parse/)
  })
})

describe("resolveModelEnv — per-initiator overlay, no shared fallback", () => {
  const CRED_ENV = [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
  ]
  const clean = () => {
    for (const k of CRED_ENV) delete process.env[k]
  }
  const cfg = (over = {}) => ({ providerName: "claude-code", server: "https://derive.to", ...over })
  // The server returns { credential, reason }. Fake it: a credential implies reason "none".
  const client = (credential, { throws = false, reason = "none", source = "pool" } = {}) => ({
    calls: [],
    persisted: [],
    async modelCredential(provider, sessionId = null) {
      this.calls.push({ provider, sessionId })
      if (throws) throw new Error("404")
      return {
        credential,
        reason: credential ? "none" : reason,
        source: credential ? source : null,
      }
    },
    async updateModelCredential(provider, sessionId, token, src, prevSha256) {
      this.persisted.push({ provider, sessionId, token, source: src, prevSha256 })
    },
  })

  it("returns the initiator's plan as an OVERLAY — process.env is never mutated", async () => {
    clean()
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "host-value-should-survive"
    const { env } = await resolveModelEnv(cfg(), client({ kind: "oauth", value: "ASKER-A" }))
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "ASKER-A" })
    // The overlay is separate from process.env, so the NEXT session starts clean.
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("host-value-should-survive")
    clean()
  })

  it("passes the session id through, so the server can resolve the ASKER's plan", async () => {
    clean()
    const c = client({ kind: "oauth", value: "x" })
    await resolveModelEnv(cfg(), c, "ses_123")
    expect(c.calls).toEqual([{ provider: "claude-code", sessionId: "ses_123" }])
    clean()
  })

  it("FAILS CLOSED when nothing resolves — connect-your-plan message", async () => {
    clean()
    await expect(resolveModelEnv(cfg(), client(null))).rejects.toThrow(/no model plan connected/)
    clean()
  })

  it("a stray HOST token is NOT a fallback: still fails closed when nothing resolves", async () => {
    clean()
    // Even with a global token in the env, an unconnected initiator fails closed —
    // there is no ambient path anymore.
    process.env.ANTHROPIC_API_KEY = "stray-host-key"
    await expect(resolveModelEnv(cfg(), client(null))).rejects.toThrow(/no model plan connected/)
    clean()
  })

  it("an UNREADABLE stored token tells the user to reconnect, not to connect", async () => {
    clean()
    await expect(resolveModelEnv(cfg(), client(null, { reason: "unreadable" }))).rejects.toThrow(
      /reconnect/i,
    )
    clean()
  })

  it("a lookup error fails the run closed (a run can't start without a plan)", async () => {
    clean()
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "stray-host-key"
    await expect(resolveModelEnv(cfg(), client(null, { throws: true }))).rejects.toThrow(
      /couldn't reach the model-plan endpoint/,
    )
    clean()
  })

  it("rejects a credential kind the provider can't inject (codex plan/oauth)", async () => {
    clean()
    await expect(
      resolveModelEnv(cfg({ providerName: "codex" }), client({ kind: "oauth", value: "x" })),
    ).rejects.toThrow(/can't be injected/)
    clean()
  })

  it("stripModelTokens removes every inherited model-auth var (incl CODEX_HOME), keeps the rest", () => {
    const stripped = stripModelTokens({
      PATH: "/usr/bin",
      CLAUDE_CODE_OAUTH_TOKEN: "a",
      ANTHROPIC_API_KEY: "b",
      OPENAI_API_KEY: "c",
      CODEX_API_KEY: "d",
      CODEX_HOME: "/home/x/.codex",
    })
    expect(stripped).toEqual({ PATH: "/usr/bin" })
  })

  it("a Codex plan LOGIN is written to a private per-run CODEX_HOME; a refresh persists, then cleanup", async () => {
    clean()
    const authJson = '{"tokens":{"access_token":"a","refresh_token":"r"},"last_refresh":"t0"}'
    const c = client({ kind: "login", value: authJson })
    const { env, cleanup } = await resolveModelEnv(cfg({ providerName: "codex" }), c, "ses_1")
    // The overlay points Codex at the private dir, nothing else.
    expect(Object.keys(env)).toEqual(["CODEX_HOME"])
    const authPath = join(env.CODEX_HOME, "auth.json")
    expect(readFileSync(authPath, "utf8")).toBe(authJson)
    // Simulate Codex rotating the single-use token in place during the run.
    const refreshed = '{"tokens":{"access_token":"a2","refresh_token":"r2"},"last_refresh":"t1"}'
    writeFileSync(authPath, refreshed)
    await cleanup()
    // The rotated blob is persisted, bound to the tier it read (source) and CAS-guarded by the
    // seed hash, so the next run doesn't seed a burned token...
    expect(c.persisted).toHaveLength(1)
    expect(c.persisted[0]).toMatchObject({
      provider: "codex",
      sessionId: "ses_1",
      token: refreshed,
      source: "pool",
    })
    expect(c.persisted[0].prevSha256).toMatch(/^[0-9a-f]{64}$/)
    // ...and the dir is gone.
    expect(existsSync(env.CODEX_HOME)).toBe(false)
    clean()
  })

  it("an UNCHANGED login is not persisted (no needless write)", async () => {
    clean()
    const c = client({ kind: "login", value: '{"tokens":{"x":1}}' })
    const { cleanup } = await resolveModelEnv(cfg({ providerName: "codex" }), c, "ses_2")
    await cleanup()
    expect(c.persisted).toEqual([])
    clean()
  })

  it("a GARBAGE (non-JSON) auth.json after a run is NOT persisted", async () => {
    clean()
    const c = client({ kind: "login", value: '{"tokens":{"x":1}}' })
    const { env, cleanup } = await resolveModelEnv(cfg({ providerName: "codex" }), c, "ses_g")
    // A crashed CLI leaves a truncated file — must never be persisted over the good token.
    writeFileSync(join(env.CODEX_HOME, "auth.json"), "not json {truncated")
    await cleanup()
    expect(c.persisted).toEqual([])
    clean()
  })
})

describe("codex provider", () => {
  const fakeCodex = (reply) => {
    const dir = mkdtempSync(join(tmpdir(), "fake-codex-"))
    const bin = join(dir, "codex")
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\n${reply}\n`)
    chmodSync(bin, 0o755)
    return { bin, args: () => readFileSync(join(dir, "args"), "utf8") }
  }

  it("runs `codex exec` with the model and the combined prompt, and parses the reply", async () => {
    const fake = fakeCodex(`
printf '%s\n' '{"type":"thread.started","thread_id":"thread_42"}'
printf '%s\n' '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"DERIVE_TOKEN=dkrun_abcdefghijklmnop node derive-source.mjs lookup {}","exit_code":0}}'
printf '%s\n' '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"<answer>{\\"body_md\\":\\"42\\"}</answer>"}}'
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":4}}'
`)
    const meter = { costUsd: null, actions: [] }
    const out = await runAgent(codex, {
      bin: fake.bin,
      cwd: tmpdir(),
      model: "gpt-5-codex",
      timeoutMs: 30_000,
      systemPrompt: "you are a runner",
      prompt: "how many?",
      meter,
    })
    expect(out.ok).toBe(true)
    expect(out.answer.body_md).toBe("42")
    expect(meter).toMatchObject({
      threadId: "thread_42",
      actions: [{ type: "command_execution", exit_code: 0 }],
      usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 4 },
    })
    expect(JSON.stringify(meter)).not.toContain("dkrun_abcdefghijklmnop")
    const args = fake.args()
    expect(args).toContain("exec")
    expect(args).toContain("--json")
    expect(args).toContain("--ephemeral")
    expect(args).toContain("workspace-write")
    expect(args).toContain("gpt-5-codex")
    // System prompt (with the appended contract) and the task travel in one prompt.
    expect(args).toContain("you are a runner")
    expect(args).toContain("how many?")
  })

  it("applies a run's provider snapshot without inheriting another provider's binary/model", () => {
    const cfg = {
      providerName: "claude-code",
      agentBin: "/bin/claude",
      model: "sonnet",
    }
    expect(
      configForRun(
        cfg,
        { execution: { provider: "codex", location: "hosted", model: null } },
        {
          AGENT_BIN: "/wrong/generic",
          RUNNER_MODEL: "wrong-generic-model",
          CODEX_BIN: "/bin/codex",
          CODEX_MODEL: "gpt-current",
        },
      ),
    ).toMatchObject({
      providerName: "codex",
      agentBin: "/bin/codex",
      model: "gpt-current",
    })
  })
})

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { claudeCode } from "../src/providers/claude-code.js"
import { codex } from "../src/providers/codex.js"
import { DEFAULT_PROVIDER, PROVIDERS, selectProvider } from "../src/providers/index.js"
import { applyModelCredential, loadRunnerConfig, runAgent } from "../src/runner.js"

describe("provider registry", () => {
  it("defaults to claude-code, resolves known names, and throws on an unknown one", () => {
    expect(DEFAULT_PROVIDER).toBe("claude-code")
    expect(selectProvider().name).toBe("claude-code")
    expect(selectProvider("codex").name).toBe("codex")
    expect(Object.keys(PROVIDERS).sort()).toEqual(["claude-code", "codex"])
    expect(() => selectProvider("nope")).toThrow(/unknown provider "nope"/)
  })

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

describe("credentialEnv", () => {
  it("claude-code maps oauth→CLAUDE_CODE_OAUTH_TOKEN and api_key→ANTHROPIC_API_KEY", () => {
    expect(claudeCode.credentialEnv("oauth", "tok")).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "tok" })
    expect(claudeCode.credentialEnv("api_key", "sk")).toEqual({ ANTHROPIC_API_KEY: "sk" })
  })
  it("codex maps api_key→OPENAI_API_KEY; a plan (oauth) login is file-based, so null for now", () => {
    expect(codex.credentialEnv("api_key", "sk")).toEqual({ OPENAI_API_KEY: "sk" })
    expect(codex.credentialEnv("oauth", "tok")).toBeNull()
  })
})

describe("applyModelCredential — per-user isolation + fail-closed", () => {
  const CRED_ENV = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]
  const clean = () => {
    for (const k of CRED_ENV) delete process.env[k]
  }
  const cfg = (over = {}) => ({ providerName: "claude-code", server: "https://derive.to", ...over })
  const client = (credential, throws = false) => ({
    modelCredential: async () => {
      if (throws) throw new Error("404")
      return credential
    },
  })

  it("injects the owner's connected plan into this run's env (and overrides any ambient)", async () => {
    clean()
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "GLOBAL-should-be-overridden"
    await applyModelCredential(cfg(), client({ kind: "oauth", value: "OWNER-A" }))
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("OWNER-A")
    clean()
  })

  it("FAILS CLOSED when the owner has no plan and no ambient token is set", async () => {
    clean()
    await expect(applyModelCredential(cfg(), client(null))).rejects.toThrow(
      /no model plan connected/,
    )
    clean()
  })

  it("falls back to an ambient token (self-host's single plan) when the owner has none", async () => {
    clean()
    process.env.ANTHROPIC_API_KEY = "self-host-key"
    await expect(applyModelCredential(cfg(), client(null))).resolves.toBeUndefined()
    clean()
  })

  it("a lookup error degrades to the ambient path rather than crashing the run", async () => {
    clean()
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "ambient"
    await expect(applyModelCredential(cfg(), client(null, true))).resolves.toBeUndefined()
    clean()
  })

  it("rejects a credential kind the provider can't inject (codex plan/oauth)", async () => {
    clean()
    await expect(
      applyModelCredential(cfg({ providerName: "codex" }), client({ kind: "oauth", value: "x" })),
    ).rejects.toThrow(/can't be injected/)
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
    const fake = fakeCodex(`echo '<answer>{"body_md":"42"}</answer>'`)
    const out = await runAgent(codex, {
      bin: fake.bin,
      cwd: tmpdir(),
      model: "gpt-5-codex",
      timeoutMs: 30_000,
      systemPrompt: "you are a runner",
      prompt: "how many?",
    })
    expect(out.ok).toBe(true)
    expect(out.answer.body_md).toBe("42")
    const args = fake.args()
    expect(args).toContain("exec")
    expect(args).toContain("gpt-5-codex")
    // System prompt (with the appended contract) and the task travel in one prompt.
    expect(args).toContain("you are a runner")
    expect(args).toContain("how many?")
  })
})

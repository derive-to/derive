import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { codex } from "../src/providers/codex.js"
import { runAgent, stripModelTokens } from "../src/runner.js"

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

describe("the model environment", () => {
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
})

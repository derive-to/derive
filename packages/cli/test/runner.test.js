import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  buildPrompt,
  loadRunnerConfig,
  OUTPUT_CONTRACT,
  parseAnswer,
  renderServiceUnit,
} from "../src/runner.js"

describe("parseAnswer", () => {
  const good = `Here is my analysis.\n<answer>{"body_md":"32%","query":"select 1","confidence":0.9,"caveats":["small n"],"escalate":false,"escalation_reason":null}</answer>`

  it("extracts and validates a well-formed answer", () => {
    const { answer } = parseAnswer(good)
    expect(answer).toMatchObject({ body_md: "32%", confidence: 0.9, caveats: ["small n"] })
  })

  it("strips ```json fences inside the tags", () => {
    expect(parseAnswer('<answer>\n```json\n{"body_md":"ok"}\n```\n</answer>').answer.body_md).toBe(
      "ok",
    )
  })

  it("clamps confidence into [0,1] and defaults the optional fields", () => {
    const { answer } = parseAnswer('<answer>{"body_md":"x","confidence":7}</answer>')
    expect(answer).toMatchObject({ confidence: 1, query: null, caveats: [], escalate: false })
  })

  it("rejects a missing block, bad JSON, and an empty body", () => {
    expect(parseAnswer("no block here").error).toMatch(/no <answer>/)
    expect(parseAnswer("<answer>{nope}</answer>").error).toMatch(/parse/)
    expect(parseAnswer('<answer>{"body_md":"  "}</answer>').error).toMatch(/body_md/)
  })

  it("carries escalation through", () => {
    const { answer } = parseAnswer(
      '<answer>{"body_md":"draft","escalate":true,"escalation_reason":"pricing"}</answer>',
    )
    expect(answer).toMatchObject({ escalate: true, escalation_reason: "pricing" })
  })

  it("accepts a well-formed artifact; malformed/oversized/blank ones demote to null", () => {
    const ok = parseAnswer(
      '<answer>{"body_md":"chart below","artifact":{"title":"Orgs by provider","html":"<!doctype html><svg></svg>"}}</answer>',
    )
    expect(ok.answer.artifact).toMatchObject({ title: "Orgs by provider" })
    expect(
      parseAnswer('<answer>{"body_md":"x","artifact":{"title":"t"}}</answer>').answer.artifact,
    ).toBeNull()
    expect(
      parseAnswer('<answer>{"body_md":"x","artifact":{"title":" ","html":"<p>"}}</answer>').answer
        .artifact,
    ).toBeNull()
    const huge = JSON.stringify({
      body_md: "x",
      artifact: { title: "t", html: "a".repeat(2_000_001) },
    })
    expect(parseAnswer(`<answer>${huge}</answer>`).answer.artifact).toBeNull()
    // Model-generated titles are clamped to card width.
    const long = JSON.stringify({
      body_md: "x",
      artifact: { title: "t".repeat(300), html: "<p>x</p>" },
    })
    expect(parseAnswer(`<answer>${long}</answer>`).answer.artifact.title).toHaveLength(120)
  })
})

describe("buildPrompt", () => {
  it("replays the transcript with roles and points at the latest ASKER message", () => {
    const p = buildPrompt([
      { author_kind: "asker", body_md: "churn?" },
      { author_kind: "agent", body_md: "32%" },
      { author_kind: "asker", body_md: "and feb?" },
    ])
    expect(p).toContain("[asker] churn?")
    expect(p).toContain("[you] 32%")
    expect(p).toContain("Answer the asker's latest message")
  })
})

describe("loadRunnerConfig", () => {
  it("requires a token and context; flags win over env", () => {
    expect(() => loadRunnerConfig({}, {})).toThrow(/required/)
    const cfg = loadRunnerConfig(
      { DERIVE_TOKEN: "env-tok", DERIVE_CONTEXT: "ctx_env", RUNNER_MODEL: "opus" },
      { context: "ctx_flag", model: "sonnet" },
    )
    expect(cfg.contextId).toBe("ctx_flag")
    expect(cfg.model).toBe("sonnet")
    expect(cfg.token).toBe("env-tok")
    expect(cfg.server).toBe("https://derive.to") // cloud default
  })

  it("reads the token from --token-file (whitespace-stripped)", () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-test-"))
    const f = join(dir, "tok")
    writeFileSync(f, "  dk_agt_abc\n")
    const cfg = loadRunnerConfig({}, { "token-file": f, context: "ctx_x" })
    expect(cfg.token).toBe("dk_agt_abc")
  })

  it("floors malformed poll/timeout values instead of passing NaN to setTimeout", () => {
    const cfg = loadRunnerConfig(
      { DERIVE_TOKEN: "t", DERIVE_CONTEXT: "ctx_x", RUNNER_POLL_MS: "5s", RUNNER_TIMEOUT_MS: "-1" },
      {},
    )
    expect(cfg.pollMs).toBe(5_000)
    expect(cfg.timeoutMs).toBe(600_000)
  })
})

describe("output contract + service units", () => {
  it("the parse anchor comes from the runner, not the author-editable manifest", () => {
    expect(OUTPUT_CONTRACT).toContain("<answer>")
    expect(OUTPUT_CONTRACT).toContain("body_md")
  })

  it("renders a launchd plist on darwin and a systemd unit on linux", () => {
    const cfg = {
      server: "https://derive.to",
      contextId: "ctx_abc",
      cwd: "/work",
      claudeBin: "/usr/local/bin/claude",
      model: "sonnet",
      tokenFile: "/secrets/tok",
    }
    const mac = renderServiceUnit(cfg, "/opt/cli/bin/derive.js", "darwin")
    expect(mac.unit).toContain("<string>ctx_abc</string>")
    expect(mac.unit).toContain("<string>--token-file</string>")
    expect(mac.path).toContain("to.derive.runner.abc")
    const linux = renderServiceUnit(cfg, "/opt/cli/bin/derive.js", "linux")
    expect(linux.unit).toContain("ExecStart=")
    expect(linux.unit).toContain("runner serve ctx_abc")
    expect(linux.unit).toContain("Restart=on-failure")
  })
})

import { describe, expect, it } from "vitest"
import { buildPrompt, OUTPUT_CONTRACT, parseAnswer } from "../src/claude"
import { loadConfig } from "../src/config"

describe("parseAnswer", () => {
  const good = `Here is my analysis.\n<answer>{"body_md":"32%","query":"select 1","confidence":0.9,"caveats":["small n"],"escalate":false,"escalation_reason":null}</answer>`

  it("extracts and validates a well-formed answer", () => {
    const { answer } = parseAnswer(good)
    expect(answer).toMatchObject({ body_md: "32%", confidence: 0.9, caveats: ["small n"] })
  })

  it("strips ```json fences inside the tags", () => {
    const fenced = `<answer>\n\`\`\`json\n{"body_md":"ok"}\n\`\`\`\n</answer>`
    expect(parseAnswer(fenced).answer?.body_md).toBe("ok")
  })

  it("clamps confidence into [0,1] and defaults the optional fields", () => {
    const { answer } = parseAnswer(`<answer>{"body_md":"x","confidence":7}</answer>`)
    expect(answer).toMatchObject({ confidence: 1, query: null, caveats: [], escalate: false })
  })

  it("rejects a missing block, bad JSON, and an empty body", () => {
    expect(parseAnswer("no block here").error).toMatch(/no <answer>/)
    expect(parseAnswer("<answer>{nope}</answer>").error).toMatch(/parse/)
    expect(parseAnswer(`<answer>{"body_md":"  "}</answer>`).error).toMatch(/body_md/)
  })

  it("carries escalation through", () => {
    const { answer } = parseAnswer(
      `<answer>{"body_md":"draft","escalate":true,"escalation_reason":"pricing"}</answer>`,
    )
    expect(answer).toMatchObject({ escalate: true, escalation_reason: "pricing" })
  })
})

describe("buildPrompt", () => {
  it("replays the transcript with roles and ends on the standing instruction", () => {
    const p = buildPrompt([
      {
        id: "1",
        author_kind: "asker",
        author_id: "u",
        body_md: "churn?",
        meta: null,
        created_at: "",
      },
      { id: "2", author_kind: "agent", author_id: "a", body_md: "32%", meta: null, created_at: "" },
      {
        id: "3",
        author_kind: "asker",
        author_id: "u",
        body_md: "and feb?",
        meta: null,
        created_at: "",
      },
    ])
    expect(p).toContain("[asker] churn?")
    expect(p).toContain("[you] 32%")
    expect(p.trim().endsWith("Answer the asker's latest message.")).toBe(true)
  })
})

describe("config + contract", () => {
  it("requires server, token, and context id", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/required/)
    const cfg = loadConfig({
      DERIVE_SERVER: "https://derive.to/",
      DERIVE_TOKEN: "t",
      DERIVE_CONTEXT: "ctx_1",
      RUNNER_MOCK: "1",
    } as NodeJS.ProcessEnv)
    expect(cfg.server).toBe("https://derive.to") // trailing slash normalized
    expect(cfg.mock).toBe(true)
  })

  it("the output contract keeps the parse anchor stable", () => {
    // The manifest is author-editable; the <answer> anchor must come from us.
    expect(OUTPUT_CONTRACT).toContain("<answer>")
    expect(OUTPUT_CONTRACT).toContain("body_md")
  })
})

import { describe, expect, it } from "vitest"
import { type ChatTurnInput, runChatTurn } from "../src/lib/chat-turn"

const baseInput = (purpose?: "context_builder"): ChatTurnInput => ({
  session: {
    id: "ses_t",
    org_id: "default",
    context_id: null,
    context_version: null,
    asker_id: "u-1",
    subject_ref: null,
    state: "open",
    created_at: new Date().toISOString(),
    updated_at: null,
    started_at: null,
    lease_until: null,
    result_artifact_id: null,
    dedupe_key: null,
  } as ChatTurnInput["session"],
  transcript: [
    {
      id: "sm_1",
      session_id: "ses_t",
      author_kind: "asker",
      author_id: "u-1",
      body_md: "I want a helper for our pricing docs",
      meta: null,
      created_at: new Date().toISOString(),
    } as ChatTurnInput["transcript"][number],
  ],
  tools: { tools: [], execute: async () => ({}), skills: [] },
  workspaceName: "Acme",
  asker: { name: "Pat", role: "editor" },
  skills: [],
  ...(purpose ? { purpose } : {}),
})

describe("chat turn purpose", () => {
  it("context_builder swaps in the builder prompt", async () => {
    let system = ""
    await runChatTurn(
      {
        model: {
          id: "m",
          label: "M",
          isDefault: true,
          callModel: async (args: { system: string }) => {
            system = args.system
            return { text: "hi", toolUses: [], costUsd: null, done: true }
          },
        },
      },
      baseInput("context_builder"),
    )
    expect(system).toContain("You are helping Pat set up a context")
    // The prompt necessarily names the draft_manifest tool; the jargon ban applies to
    // what the model SAYS, so assert the ban instruction itself is in the voice.
    expect(system).toContain('Never use the words "manifest"')
  })

  it("absent purpose keeps the workspace prompt", async () => {
    let system = ""
    await runChatTurn(
      {
        model: {
          id: "m",
          label: "M",
          isDefault: true,
          callModel: async (args: { system: string }) => {
            system = args.system
            return { text: "hi", toolUses: [], costUsd: null, done: true }
          },
        },
      },
      baseInput(),
    )
    expect(system).not.toContain("set up a context")
  })

  it("gives both agent paths the exact chosen template without putting it in user prose", async () => {
    for (const purpose of [undefined, "context_builder"] as const) {
      let system = ""
      await runChatTurn(
        {
          model: {
            id: "m",
            label: "M",
            isDefault: true,
            callModel: async (args: { system: string }) => {
              system = args.system
              return { text: "hi", toolUses: [], costUsd: null, done: true }
            },
          },
        },
        {
          ...baseInput(purpose),
          templateStart: {
            uri: "derive://templates/narrative-pitch",
            title: "Narrative pitch",
            kind: purpose ? "context" : "artifact",
          },
        },
      )
      expect(system).toContain("derive://templates/narrative-pitch")
      expect(system).toMatch(/read that exact (template|reference|URI)/i)
      expect(system).toMatch(/adapt|substantially authored/i)
    }
  })
})

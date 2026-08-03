import type { SessionMessageRecord, SessionRecord } from "@derive/core"
import { describe, expect, it } from "vitest"
import { runChatTurn } from "../src/lib/chat-turn"

// WHAT THE AGENT IS TOLD ABOUT THE PERSON IT IS TALKING TO.
//
// The tools already ENFORCE reach: a chat turn runs Derive's real MCP handlers as a principal
// built from the asker's own seat, so it can touch exactly what they can touch. That is not what
// these tests are about. These are about the agent KNOWING it — because an agent that cannot see
// a teammate's invite-only document, and does not know that is why, reports "there is nothing in
// this workspace about X". Invisibility read back as absence is the one wrong answer a person has
// no way to catch, since the screen agrees with it.
//
// The prompt is not observable from the outside, so these capture it through the model client —
// the same seam the turn actually calls.

const session = { id: "s1", org_id: "ws1" } as unknown as SessionRecord
const transcript: SessionMessageRecord[] = [
  {
    id: "m1",
    author_kind: "asker",
    body_md: "where are the pricing docs",
    created_at: new Date(0).toISOString(),
  } as unknown as SessionMessageRecord,
]

/** Run one turn against a model that records its system prompt and answers trivially. */
const promptFor = async (role: "owner" | "editor" | "commenter" | "viewer") => {
  let captured = ""
  await runChatTurn(
    {
      model: {
        id: "m",
        label: "M",
        callModel: async (input: { system: string }) => {
          captured = input.system
          return { text: "ok", toolUses: [], costUsd: null, done: true }
        },
      } as never,
    },
    {
      session,
      transcript,
      tools: { tools: [], execute: async () => ({}), skills: [] },
      workspaceName: "Acme",
      asker: { name: "Priya", role },
      skills: [],
    },
  )
  return captured
}

describe("what a chat turn knows about who is asking", () => {
  it("names the person's seat in the words the app uses, not the storage vocabulary", async () => {
    expect(await promptFor("owner")).toContain("an Admin")
    expect(await promptFor("editor")).toContain("a Creator")
    expect(await promptFor("commenter")).toContain("a Viewer")
    // A legacy bare viewer is still a Viewer to a person.
    expect(await promptFor("viewer")).toContain("a Viewer")
    // Never the raw role — "you are a commenter" is a sentence about our database.
    const prompt = await promptFor("commenter")
    expect(prompt).not.toMatch(/\byou are a commenter\b/i)
  })

  it("tells the agent its reach IS the asker's reach, so it cannot report absence", async () => {
    const prompt = await promptFor("editor")
    expect(prompt).toMatch(/permissions/i)
    // The distinction that matters: could not find ≠ does not exist.
    expect(prompt).toMatch(/could not find/i)
  })

  it("carries the person's name and workspace, so it can answer as a colleague would", async () => {
    const prompt = await promptFor("owner")
    expect(prompt).toContain("Priya")
    expect(prompt).toContain("Acme")
  })
})

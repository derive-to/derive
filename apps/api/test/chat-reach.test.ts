import type { SessionMessageRecord, SessionRecord } from "@derive/core"
import { describe, expect, it } from "vitest"
import { runChatTurn } from "../src/lib/chat-turn"
import { CHAT_UNVERIFIED_NOTE } from "../src/lib/slack-identity"

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
const promptFor = async (role: "owner" | "editor" | "commenter" | "viewer", note?: string) => {
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
      asker: { name: "Priya", role, ...(note ? { note } : {}) },
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

// WHEN THE SEAT IN THE PROMPT IS NOT THE SEAT THE PERSON HOLDS.
//
// The Slack lane clamps an email-matched asker to `viewer` (lib/slack-identity.ts). That is
// invisible from inside the turn — the tools simply behave as a viewer's — so without the note
// the agent states the clamped role as fact to a Creator, and relays refusals written for a
// different surface. Both send somebody to a place that cannot help them.

describe("a seat the turn was handed rather than the one the person holds", () => {
  it("carries the reason into the prompt, verbatim", async () => {
    const prompt = await promptFor("viewer", CHAT_UNVERIFIED_NOTE)
    expect(prompt).toContain(CHAT_UNVERIFIED_NOTE)
  })

  it("says nothing extra when the seat is genuinely theirs", async () => {
    // The web lane never sets it: a session IS the account, so there is nothing to explain.
    const prompt = await promptFor("viewer")
    expect(prompt).not.toContain("Settings → Integrations")
    expect(prompt).toContain("a Viewer")
  })

  it("names the fix, and disowns the advice the tools would otherwise give", async () => {
    // The failure this exists to stop: `publish` and `comment` answer a blocked write with
    // "re-authorize the connector with derive:comment", which is about an MCP grant and is
    // unfollowable from Slack.
    expect(CHAT_UNVERIFIED_NOTE).toContain("Settings → Integrations")
    expect(CHAT_UNVERIFIED_NOTE).toMatch(/do not repeat .*connector|connector/i)
    // And the half that is easy to forget: it must not silence the answers that still work.
    expect(CHAT_UNVERIFIED_NOTE).toMatch(/works normally/i)
  })
})

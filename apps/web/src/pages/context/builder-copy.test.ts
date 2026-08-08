import { describe, expect, it } from "vitest"
import { BUILDER_COPY } from "./builder-copy"

// The reason this flow exists: the concepts a first-timer fell over must not
// appear in anything the flow says to them. The agent prompt (spoken to an
// agent) and the expert door label are the two deliberate exceptions.
const BANNED = [/manifest/i, /short.?id/i, /runner.?token/i, /\bserve\b/i]
const EXEMPT = new Set(["agentDoorPrompt", "expertDoor"])

describe("builder copy stays jargon-free", () => {
  for (const [key, value] of Object.entries(BUILDER_COPY)) {
    if (EXEMPT.has(key)) continue
    it(key, () => {
      for (const pattern of BANNED) expect(value).not.toMatch(pattern)
    })
  }
})

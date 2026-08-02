import { DEFAULT_ORG_SETTINGS } from "@derive/core"
import { describe, expect, it } from "vitest"

// WHICH CONNECTIONS A CONVERSATION MAY REACH.
//
// A packaged run declares its own connections, so a Stripe-bound run sees Stripe and nothing
// else. A conversation declares nothing — somebody types a sentence — so this list is the
// missing declaration, made by whoever owns the credential rather than whoever is typing.

describe("chat source binding", () => {
  it("is EMPTY by default, so connecting a server never widens chat on its own", () => {
    // The whole safety property of the feature. An admin connecting Stripe for automations
    // must not thereby hand every chat turn in the workspace a payments API.
    expect(DEFAULT_ORG_SETTINGS.chatSources).toEqual([])
  })

  it("is separate from chatBeta — being able to chat is not being able to reach a source", () => {
    expect(DEFAULT_ORG_SETTINGS.chatBeta).toBe(true)
    expect(DEFAULT_ORG_SETTINGS.chatSources).toHaveLength(0)
  })
})

import { describe, expect, it } from "vitest"
import type { AgentRecord } from "../src/ports"
import { isAuthenticated, type Principal, principalActor, principalOwnerId } from "../src/principal"

// The pure request-identity helpers: given a resolved Principal, who is the human behind
// the request (ownership/attribution) and who is the acting identity (authorship byline).
// These fold the four historical resolvers' logic into one typed source of truth.

const agent = (over: Partial<AgentRecord> = {}): AgentRecord => ({
  id: "ag_1",
  org_id: "o1",
  name: "Claude",
  token: "",
  role: "commenter",
  created_by: null,
  created_at: "2026-07-06T00:00:00.000Z",
  ...over,
})

const human: Principal = {
  kind: "human",
  user: { id: "u1", email: "a@x.com", name: "Ada", username: "ada" },
}

describe("principalOwnerId — the human behind a request", () => {
  it("is the user themselves for a human principal", () => {
    expect(principalOwnerId(human)).toBe("u1")
  })
  it("is the on-behalf human for an agent (delegation as data)", () => {
    expect(principalOwnerId({ kind: "agent", agent: agent(), onBehalfOf: "u9" })).toBe("u9")
  })
  it("is null for an agent with no granting human (a bare registered agent)", () => {
    expect(principalOwnerId({ kind: "agent", agent: agent(), onBehalfOf: null })).toBeNull()
  })
  it("is null for anonymous and the static token", () => {
    expect(principalOwnerId({ kind: "anonymous" })).toBeNull()
    expect(principalOwnerId({ kind: "token" })).toBeNull()
  })
})

describe("principalActor — the authorship byline identity", () => {
  it("an agent authors as ITSELF, never spoofing the human it acts for", () => {
    expect(principalActor({ kind: "agent", agent: agent(), onBehalfOf: "u9" })).toEqual({
      id: "ag_1",
      name: "Claude",
    })
  })
  it("a human authors as themselves, preferring handle over email", () => {
    expect(principalActor(human)).toEqual({ id: "u1", name: "ada" })
    expect(
      principalActor({
        kind: "human",
        user: { id: "u2", email: "b@x.com", name: null, username: "bo" },
      }),
    ).toEqual({ id: "u2", name: "bo" })
    // Email is only the last-ditch fallback when name + handle are both unset.
    expect(
      principalActor({
        kind: "human",
        user: { id: "u3", email: "c@x.com", name: null, username: null },
      }),
    ).toEqual({ id: "u3", name: "c@x.com" })
  })
  it("is null for anonymous and the static token (no authored byline)", () => {
    expect(principalActor({ kind: "anonymous" })).toBeNull()
    expect(principalActor({ kind: "token" })).toBeNull()
  })
})

describe("isAuthenticated — the not-anonymous predicate", () => {
  it("is true for token, human, and agent; false only for anonymous", () => {
    expect(isAuthenticated({ kind: "token" })).toBe(true)
    expect(isAuthenticated(human)).toBe(true)
    expect(isAuthenticated({ kind: "agent", agent: agent(), onBehalfOf: null })).toBe(true)
    expect(isAuthenticated({ kind: "anonymous" })).toBe(false)
  })
})

import { describe, expect, it } from "vitest"
import type { Comment } from "@/api"
import { REACTION_EMOJI, toggleReaction } from "./reactions"

const comment = (reactions: Record<string, string[]> = {}): Comment =>
  ({ id: "c1", thread_id: "t1", reactions }) as unknown as Comment

describe("toggleReaction", () => {
  it("adds a reaction when the user hasn't reacted", () => {
    const out = toggleReaction(comment(), "👍", "amy")
    expect(out.reactions).toEqual({ "👍": ["amy"] })
  })

  it("removes the reaction (and drops the empty emoji key) when toggled off", () => {
    const out = toggleReaction(comment({ "👍": ["amy"] }), "👍", "amy")
    expect(out.reactions).toEqual({})
  })

  it("appends a second reactor without disturbing the first", () => {
    const out = toggleReaction(comment({ "👍": ["amy"] }), "👍", "bob")
    expect(out.reactions?.["👍"]).toEqual(["amy", "bob"])
  })

  it("does not mutate the input comment", () => {
    const input = comment({ "❤️": ["amy"] })
    toggleReaction(input, "❤️", "bob")
    expect(input.reactions).toEqual({ "❤️": ["amy"] })
  })

  it("exposes a stable emoji palette", () => {
    expect(REACTION_EMOJI).toContain("👍")
    expect(REACTION_EMOJI.length).toBeGreaterThan(0)
  })
})

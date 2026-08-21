import type { Role, SlackUserLinkRecord } from "@derive/core"
import { describe, expect, it } from "vitest"
import { chatSeatFor, isVerifiedLink, linkToActMessage } from "../src/lib/slack-identity"

// Two things can put a row in slack_user_link and they are not the same claim: `oauth` proves
// control of the Derive account, `email` only matched its address. Reading may rest on either —
// the address is one the workspace's own directory verified, and membership is checked anyway.
// Writing may not: an admin can set a Slack profile email through SCIM without the mailbox, and
// that must not become the power to settle a review or comment under somebody's name.
const link = (origin: SlackUserLinkRecord["origin"]) => ({ origin }) as SlackUserLinkRecord

describe("isVerifiedLink", () => {
  it("accepts only a deliberate sign-in", () => {
    expect(isVerifiedLink(link("oauth"))).toBe(true)
    expect(isVerifiedLink(link("email"))).toBe(false)
    // A miss never reaches the filtered accessor, but the predicate must not crown one if it did.
    expect(isVerifiedLink(link("miss"))).toBe(false)
    expect(isVerifiedLink(null)).toBe(false)
    expect(isVerifiedLink(undefined)).toBe(false)
  })
})

describe("chatSeatFor", () => {
  // The enforcement for the chat lane, and deliberately not a check: the tools take their
  // ceiling from the seat, so `publish` refuses a viewer on its own. Nothing has to remember to
  // ask, and no tool list can drift out of step.
  it("clamps an unverified asker to viewer, whatever their real seat", () => {
    for (const role of ["viewer", "commenter", "editor", "owner"] as Role[])
      expect(chatSeatFor(false, role)).toBe("viewer")
  })

  it("leaves a verified asker at their real seat", () => {
    for (const role of ["viewer", "commenter", "editor", "owner"] as Role[])
      expect(chatSeatFor(true, role)).toBe(role)
  })

  // Reading is the reason email identity exists — answering a question in Slack without a detour
  // through Settings. Clamping to `viewer` rather than refusing is what keeps that working.
  it("still leaves an unverified asker able to read", () => {
    expect(chatSeatFor(false, "owner")).toBe("viewer")
  })
})

describe("linkToActMessage", () => {
  // The fix is thirty seconds away, so the refusal names the place rather than the policy.
  it("names the destination and the specific action", () => {
    const m = linkToActMessage("send back a review", link("email"))
    expect(m).toContain("Settings → Integrations")
    expect(m).toContain("send back a review")
  })

  // To somebody we just answered by name, a bare "connect your accounts" reads as amnesia — so
  // an email match is told what we know. To a stranger the same sentence would be a lie.
  it("claims to know the person only when it does", () => {
    expect(linkToActMessage("send back a review", link("email"))).toContain("from your email")
    expect(linkToActMessage("send back a review", null)).not.toContain("from your email")
    expect(linkToActMessage("send back a review")).not.toContain("from your email")
  })
})

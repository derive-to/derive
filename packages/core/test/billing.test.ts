import { describe, expect, it } from "vitest"
import { FREE_SEAT_LIMIT, resolveBillingState, STORAGE_CAPS, type SubscriptionRecord } from "../src"

const NOW = new Date("2026-07-30T12:00:00Z")
const PAST = new Date("2026-01-01T00:00:00Z")
const FUTURE = new Date("2027-01-01T00:00:00Z")

const sub = (over: Partial<SubscriptionRecord> = {}): SubscriptionRecord => ({
  org_id: "default",
  stripe_customer_id: "cus_1",
  stripe_subscription_id: "sub_1",
  tier: "team",
  billing_interval: "month",
  status: "active",
  quantity: 4,
  current_period_end: "2026-08-30T12:00:00Z",
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
  ...over,
})

describe("resolveBillingState", () => {
  it("beta (no enforceAt): everything allowed, fallback cap, white-label entitled", () => {
    const s = resolveBillingState({
      subscription: null,
      seatCount: 10,
      now: NOW,
      enforceAt: null,
      fallbackMaxBytes: 123,
    })
    expect(s).toEqual({
      tier: "free",
      subscriptionActive: false,
      canPublishApprove: true,
      storageCapBytes: 123,
      whiteLabelEntitled: true,
      betaGrace: true,
    })
  })

  it("beta with no fallback cap: storage unlimited (self-host)", () => {
    const s = resolveBillingState({ subscription: null, seatCount: 1, now: NOW })
    expect(s.storageCapBytes).toBeUndefined()
    expect(s.canPublishApprove).toBe(true)
  })

  it("an active subscription always wins, beta or enforced, and gets its tier cap", () => {
    for (const enforceAt of [null, PAST, FUTURE]) {
      const s = resolveBillingState({
        subscription: sub(),
        seatCount: 4,
        now: NOW,
        enforceAt,
        fallbackMaxBytes: 123,
      })
      expect(s.tier).toBe("team")
      expect(s.subscriptionActive).toBe(true)
      expect(s.canPublishApprove).toBe(true)
      expect(s.storageCapBytes).toBe(STORAGE_CAPS.team)
      expect(s.whiteLabelEntitled).toBe(true)
    }
  })

  it("business tier gets the business cap", () => {
    const s = resolveBillingState({
      subscription: sub({ tier: "business" }),
      seatCount: 2,
      now: NOW,
      enforceAt: PAST,
    })
    expect(s.storageCapBytes).toBe(STORAGE_CAPS.business)
  })

  it("past_due stays writable (dunning); canceled does not", () => {
    const dunning = resolveBillingState({
      subscription: sub({ status: "past_due" }),
      seatCount: 4,
      now: NOW,
      enforceAt: PAST,
    })
    expect(dunning.canPublishApprove).toBe(true)
    const lapsed = resolveBillingState({
      subscription: sub({ status: "canceled" }),
      seatCount: 4,
      now: NOW,
      enforceAt: PAST,
    })
    expect(lapsed.canPublishApprove).toBe(false)
    expect(lapsed.blockedReason).toBe("lapsed")
    expect(lapsed.whiteLabelEntitled).toBe(false)
  })

  it("enforced, no sub, within free seats: allowed at the free cap, no white-label", () => {
    const s = resolveBillingState({
      subscription: null,
      seatCount: FREE_SEAT_LIMIT,
      now: NOW,
      enforceAt: PAST,
      fallbackMaxBytes: 999,
    })
    expect(s.canPublishApprove).toBe(true)
    expect(s.storageCapBytes).toBe(STORAGE_CAPS.free)
    expect(s.whiteLabelEntitled).toBe(false)
  })

  it("enforced, no sub, 4th seat: blocked with needs_team", () => {
    const s = resolveBillingState({
      subscription: null,
      seatCount: FREE_SEAT_LIMIT + 1,
      now: NOW,
      enforceAt: PAST,
    })
    expect(s.canPublishApprove).toBe(false)
    expect(s.blockedReason).toBe("needs_team")
  })

  it("an incomplete (never-paid) sub row counts as no subscription, not lapsed", () => {
    const s = resolveBillingState({
      subscription: sub({ status: "incomplete", stripe_subscription_id: null }),
      seatCount: 2,
      now: NOW,
      enforceAt: PAST,
    })
    expect(s.canPublishApprove).toBe(true)
    expect(s.blockedReason).toBeUndefined()
  })

  it("enforceAt in the future is still beta", () => {
    const s = resolveBillingState({
      subscription: null,
      seatCount: 10,
      now: NOW,
      enforceAt: FUTURE,
    })
    expect(s.canPublishApprove).toBe(true)
    expect(s.whiteLabelEntitled).toBe(true)
  })

  it("betaGrace is true only pre-enforcement without an active subscription", () => {
    const now = new Date("2026-07-30T00:00:00Z")
    const pre = resolveBillingState({ subscription: null, seatCount: 1, now, enforceAt: null })
    expect(pre.betaGrace).toBe(true)

    const enforced = resolveBillingState({
      subscription: null,
      seatCount: 1,
      now,
      enforceAt: new Date("2026-07-01T00:00:00Z"),
    })
    expect(enforced.betaGrace).toBe(false)

    const active = resolveBillingState({
      subscription: sub({ status: "active" }),
      seatCount: 5,
      now,
      enforceAt: null,
    })
    expect(active.betaGrace).toBe(false)
  })
})

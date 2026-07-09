import { describe, expect, it } from "vitest"
import type { WebhookEvent } from "../src/events"
import { type CardInput, cardForEvent, markdownToMrkdwn } from "../src/lib/slack-cards"

const artifact = {
  short_id: "abc123",
  title: "Onboarding doc",
  url: "https://derive.to/artifacts/abc123",
}
const input = (event: WebhookEvent, data: Record<string, unknown> = {}): CardInput => ({
  event,
  artifact,
  data,
})

// Every card must carry a non-empty text fallback and only well-formed blocks.
const findButtons = (blocks: unknown[]): Record<string, unknown>[] =>
  blocks
    .filter(
      (b): b is { type: string; elements: unknown[] } =>
        (b as { type?: string }).type === "actions",
    )
    .flatMap((b) => b.elements as Record<string, unknown>[])

describe("markdownToMrkdwn", () => {
  it("rewrites links, bold, headings and bullets to mrkdwn", () => {
    expect(markdownToMrkdwn("[Derive](https://derive.to)")).toBe("<https://derive.to|Derive>")
    expect(markdownToMrkdwn("**bold** and __also__")).toBe("*bold* and *also*")
    expect(markdownToMrkdwn("# Heading")).toBe("*Heading*")
    expect(markdownToMrkdwn("- one\n- two")).toBe("• one\n• two")
  })

  it("leaves plain prose and raw HTML untouched (Slack renders HTML literally)", () => {
    expect(markdownToMrkdwn("just words")).toBe("just words")
    expect(markdownToMrkdwn("<b>not bold</b>")).toBe("<b>not bold</b>")
  })

  it("truncates to under Slack's 3000-char section limit", () => {
    const out = markdownToMrkdwn("x".repeat(5000))
    expect(out.length).toBeLessThanOrEqual(2900)
  })
})

describe("cardForEvent", () => {
  it("returns null for events mirrored as threads elsewhere", () => {
    expect(cardForEvent(input("comment.created"))).toBeNull()
    expect(cardForEvent(input("comment.mention"))).toBeNull()
  })

  const carded: [WebhookEvent, Record<string, unknown>][] = [
    ["comment.resolved", { state: "resolved", thread_id: "t1" }],
    ["version.published", { version: 3, message: "big update", author: "Ada" }],
    ["proposal.created", { proposal_id: "p1", author: "Ada", message: "tighten intro" }],
    ["proposal.approved", { proposal_id: "p1", version: 4, approver: "Grace" }],
    ["proposal.changes_requested", { proposal_id: "p1", reviewer: "Grace" }],
    ["review.requested", { version: 2, requested_by: "Ada" }],
    ["review.approved", {}],
    ["review.sent_back", {}],
  ]

  for (const [event, data] of carded) {
    it(`builds a valid card for ${event}`, () => {
      const card = cardForEvent(input(event, data))
      expect(card).not.toBeNull()
      if (!card) return
      expect(card.text.length).toBeGreaterThan(0)
      expect(card.blocks.length).toBeGreaterThan(0)
      // Section text must stay within Slack's limit.
      for (const b of card.blocks as { type: string; text?: { text: string } }[])
        if (b.type === "section" && b.text) expect(b.text.text.length).toBeLessThanOrEqual(3000)
    })
  }

  it("proposal.created carries only an Open link, no interactive buttons", () => {
    const card = cardForEvent(
      input("proposal.created", { proposal_id: "p1", author: "Ada", message: "hi" }),
    )
    if (!card) throw new Error("expected a card")
    const buttons = findButtons(card.blocks)
    expect(buttons.every((b) => typeof b.action_id !== "string")).toBe(true)
    expect(buttons.some((b) => b.url === artifact.url)).toBe(true)
  })

  it("Open buttons are URL buttons (no action_id, so they don't fire interactivity)", () => {
    const card = cardForEvent(input("version.published", { version: 1 }))
    if (!card) throw new Error("expected a card")
    const open = findButtons(card.blocks).find((b) => b.url === artifact.url)
    expect(open).toBeDefined()
    expect(open?.action_id).toBeUndefined()
  })
})

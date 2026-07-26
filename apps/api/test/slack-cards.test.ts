import { describe, expect, it } from "vitest"
import { markdownToMrkdwn } from "../src/lib/slack-cards"

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

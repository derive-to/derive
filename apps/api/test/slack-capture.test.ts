import { describe, expect, it } from "vitest"
import {
  type CapturePrivateMeta,
  captureCommentBody,
  captureOptions,
} from "../src/lib/slack-capture"

// The comment a saved Slack message becomes. Pure rendering, so it is pinned here rather than
// through the route — every case below is one a real message produces.
const msg = (over: Partial<CapturePrivateMeta> = {}): CapturePrivateMeta => ({
  channel: "C1",
  channelName: "eng",
  ts: "1700000001.1",
  author: "Dana",
  text: "ship the smaller version",
  permalink: "https://acme.slack.com/archives/C1/p1700000001",
  ...over,
})

describe("captureCommentBody", () => {
  it("quotes the message and cites where it came from", () => {
    const body = captureCommentBody(msg(), "worth capturing")
    expect(body).toBe(
      "worth capturing\n\n> ship the smaller version\n\n— [Dana in #eng](https://acme.slack.com/archives/C1/p1700000001)",
    )
  })

  it("drops the note when there isn't one, leaving no blank lead", () => {
    expect(captureCommentBody(msg(), "   ").startsWith("> ship")).toBe(true)
  })

  // Every line gets the marker. Without that, a message containing a blank line or its own text
  // after one would continue OUTSIDE the blockquote and read as the saver's own words.
  it("keeps a multi-line message inside the quote", () => {
    const body = captureCommentBody(msg({ text: "one\n\ntwo" }), "")
    expect(body).toContain("> one\n> \n> two")
    expect(body.split("\n").filter((l) => l && !l.startsWith(">") && !l.startsWith("—"))).toEqual(
      [],
    )
  })

  it("cites plainly when no permalink could be resolved", () => {
    expect(captureCommentBody(msg({ permalink: null }), "")).toContain("— Dana in #eng")
  })

  // A shortcut fired in a DM or a channel Slack didn't name.
  it("says just Slack when the channel has no name", () => {
    expect(captureCommentBody(msg({ channelName: null, permalink: null }), "")).toContain(
      "— Dana in Slack",
    )
  })
})

describe("captureOptions", () => {
  const artifact = (id: string, title: string | null, shortId = "abc123") =>
    ({ id, title, short_id: shortId }) as Parameters<typeof captureOptions>[0][number]

  it("labels by title, falling back to the short id", () => {
    const { options } = captureOptions([artifact("a1", null, "zz9")])
    expect(options[0]).toEqual({ text: { type: "plain_text", text: "zz9" }, value: "a1" })
  })

  // Slack rejects an option label over 75 characters, which would fail the WHOLE picker.
  it("truncates a long title to what Slack accepts", () => {
    const { options } = captureOptions([artifact("a1", "x".repeat(200))])
    expect(options[0]?.text.text).toHaveLength(75)
  })

  // …and caps the list at Slack's 100-option limit.
  it("caps the list at a hundred", () => {
    const many = Array.from({ length: 140 }, (_, i) => artifact(`a${i}`, `Doc ${i}`))
    expect(captureOptions(many).options).toHaveLength(100)
  })
})

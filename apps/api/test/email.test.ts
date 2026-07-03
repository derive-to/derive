import type { ArtifactRecord, DeliveryRecord } from "@derive/core"
import { describe, expect, it, vi } from "vitest"
import { buildCommentEmail, commentDeepLink, emailDeliverySender } from "../src/lib/email"
import { deliverOnce, edgeGuard } from "../src/webhooks"

const artifact = { id: "a1", short_id: "spec0001", title: "Roadmap" } as ArtifactRecord

describe("email content", () => {
  it("renders a comment email with a deep link to the thread", () => {
    const { subject, html, text } = buildCommentEmail("https://derive.to/", artifact, {
      author: "Ann",
      body: "Looks good to me",
      quote: "the second milestone",
      threadId: "t_123",
    })
    expect(subject).toBe("Ann commented on Roadmap")
    const link = commentDeepLink("https://derive.to", artifact, "t_123")
    expect(link).toBe("https://derive.to/artifacts/spec0001?comment=t_123")
    expect(html).toContain(link)
    expect(html).toContain("the second milestone")
    expect(text).toContain("View in Derive: https://derive.to/artifacts/spec0001?comment=t_123")
  })

  it("uses mention phrasing when the email is for a mention", () => {
    const { subject } = buildCommentEmail("https://derive.to", artifact, {
      author: "Ann",
      body: "hey",
      threadId: "t_1",
      mention: true,
    })
    expect(subject).toBe("Ann mentioned you on Roadmap")
  })

  it("escapes HTML in author/body to prevent injection", () => {
    const { html } = buildCommentEmail("https://derive.to", artifact, {
      author: "<script>",
      body: "<img src=x>",
      threadId: "t_1",
    })
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("<img src=x>")
    expect(html).toContain("&lt;script&gt;")
  })
})

describe("email channel delivery", () => {
  const row = (kind: DeliveryRecord["kind"], payload: unknown): DeliveryRecord =>
    ({
      id: "wd_1",
      webhook_id: "internal",
      url: "",
      secret: "",
      kind,
      event_type: "comment.created",
      payload: JSON.stringify(payload),
      status: "pending",
      attempts: 1,
      last_error: null,
      next_attempt_at: "",
      created_at: "",
    }) as DeliveryRecord

  it("hands an email row to the registered sender", async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const r = await deliverOnce(
      row("email", { to: "x@y.com", subject: "s", html: "<p>h</p>", text: "h" }),
      edgeGuard,
      { email: emailDeliverySender({ send }) },
    )
    expect(r.ok).toBe(true)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "x@y.com", subject: "s" }))
  })

  it("treats a channel kind with no sender as a delivered no-op (never dead-letters)", async () => {
    const r = await deliverOnce(row("email", { to: "x@y.com" }), edgeGuard, {})
    expect(r.ok).toBe(true)
    expect(r.status).toMatch(/no sender/)
  })

  it("a throwing sender reports a retryable failure", async () => {
    const r = await deliverOnce(row("email", { to: "x@y.com" }), edgeGuard, {
      email: emailDeliverySender({ send: () => Promise.reject(new Error("smtp down")) }),
    })
    expect(r.ok).toBe(false)
    expect(r.status).toContain("smtp down")
  })
})

import { describe, expect, it } from "vitest"
import { MAX_SECTION, mrkdwnBody } from "../src/lib/slack-cards"

const balanced = (s: string) => (s.match(/</g) ?? []).length === (s.match(/>/g) ?? []).length

describe("mrkdwnBody", () => {
  it("renders the markdown subset Slack has an equivalent for", () => {
    expect(mrkdwnBody("[Derive](https://derive.to)")).toBe("<https://derive.to|Derive>")
    expect(mrkdwnBody("**bold** and __also__")).toBe("*bold* and *also*")
    expect(mrkdwnBody("# Heading")).toBe("*Heading*")
    expect(mrkdwnBody("- one\n- two")).toBe("• one\n• two")
    expect(mrkdwnBody("just words")).toBe("just words")
  })

  // The control. A comment body is written by someone who may not be trusted with the
  // workspace's Slack channel, so it must not be able to reach Slack's control syntax:
  // `<!channel>`/`<!here>` broadcast to everyone, and `<url|label>` renders a link whose
  // visible text the author chooses — a ready-made phishing primitive.
  it("neutralizes every Slack control sequence in untrusted prose", () => {
    expect(mrkdwnBody("ping <!channel> now")).toBe("ping &lt;!channel&gt; now")
    expect(mrkdwnBody("<!here>")).toBe("&lt;!here&gt;")
    expect(mrkdwnBody("<@U123> and <#C1>")).toBe("&lt;@U123&gt; and &lt;#C1&gt;")
    expect(mrkdwnBody("<https://evil.example|Derive Support>")).toBe(
      "&lt;https://evil.example|Derive Support&gt;",
    )
  })

  it("escapes a rendered link's label so it cannot break out of the link", () => {
    expect(mrkdwnBody("[<!channel>](https://ok.example)")).toBe(
      "<https://ok.example|&lt;!channel&gt;>",
    )
  })

  // Escaping the URL (the naive escape-then-convert order) rewrites `&` to `&amp;` and
  // silently corrupts every link with a query string.
  it("keeps a link URL byte-exact", () => {
    expect(mrkdwnBody("[r](https://x.example/a?b=1&c=2)")).toBe("<https://x.example/a?b=1&c=2|r>")
  })

  it("linkifies only http(s), and refuses a URL carrying mrkdwn delimiters", () => {
    expect(mrkdwnBody("[x](javascript:alert(1))")).toBe("[x](javascript:alert(1))")
    expect(mrkdwnBody("[x](https://a|b)")).toBe("[x](https://a|b)")
    expect(mrkdwnBody("[x](https://a>b)")).toBe("[x](https://a&gt;b)")
  })

  // Escaping EXPANDS text (`&` → `&amp;`), so an input that fits the cap can render past it.
  // Clamping the output must never leave a half-written entity or link behind.
  it("never leaves a half-written entity at the clamp boundary", () => {
    const out = mrkdwnBody(`[a](https://example.com/x)${"&".repeat(40)}`, 100)
    expect(out.length).toBeLessThanOrEqual(100)
    expect(out).toContain("<https://example.com/x|a>")
    expect(out).not.toMatch(/&[a-z]*$/)
  })

  it("never leaves a half-written link at the clamp boundary", () => {
    const out = mrkdwnBody(`${"&".repeat(30)}[a](https://example.com/${"x".repeat(30)})`, 160)
    expect(out.length).toBeLessThanOrEqual(160)
    expect(balanced(out)).toBe(true)
  })

  it("stays inside Slack's section limit even when escaping expands the text", () => {
    expect(mrkdwnBody("&".repeat(3000)).length).toBeLessThanOrEqual(MAX_SECTION)
    expect(mrkdwnBody("x".repeat(5000)).length).toBeLessThanOrEqual(MAX_SECTION)
  })
})

import { describe, expect, it } from "vitest"
import { context, MAX_SECTION, mrkdwnBody, mrkdwnLabel, section } from "../src/lib/slack-cards"

const balanced = (s: string) => (s.match(/</g) ?? []).length === (s.match(/>/g) ?? []).length

describe("mrkdwnBody", () => {
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

// Regressions found by an adversarial audit of the first cut of mrkdwnBody.
describe("mrkdwnBody — clamping must not destroy a complete link", () => {
  // The output clamp repaired a half-written link, then repaired a half-written `&…;` entity by
  // scanning the WHOLE string. A URL's `&` is raw by design, so it read as a partial entity and
  // trimming back to it sliced a *complete* link in half — leaving the dangling `<` the first
  // repair had just removed, and collapsing the message to a fraction of its length.
  it("keeps an ordinary comment with an ampersand and a query link intact", () => {
    const src = `R&D notes — see [the tab](https://derive.to/a/x?tab=1&v=2) for the numbers. ${"x".repeat(600)}`
    const out = mrkdwnBody(src, 600)
    expect(balanced(out)).toBe(true)
    expect(out).toContain("<https://derive.to/a/x?tab=1&v=2|the tab>")
    expect(out.length).toBeGreaterThan(400) // used to collapse to ~49 chars
  })

  it("stays balanced at every clamp boundary", () => {
    const src = `${"&".repeat(60)}[label](https://evil.example.com/?a=1&b=2)${"y".repeat(300)}`
    for (let max = 2; max <= 1062; max++) {
      const out = mrkdwnBody(src, max)
      expect(balanced(out), `unbalanced at max=${max}: ${out.slice(-40)}`).toBe(true)
      expect(out.length).toBeLessThanOrEqual(max)
    }
  })

  it("never splits a surrogate pair", () => {
    const out = mrkdwnBody(`${"a".repeat(598)}😀${"b".repeat(50)}`, 600)
    expect(out).not.toMatch(/[\uD800-\uDBFF]$/)
    expect(JSON.parse(JSON.stringify(out))).toBe(out)
  })
})

describe("mrkdwnLabel", () => {
  // Identity fields were escaped but never bounded, and escaping expands 5x, so one long title
  // pushed a section past Slack's hard 3000-char cap -> invalid_blocks. The comment mirror posts
  // without a text fallback, so that dead-lettered the comment instead of degrading.
  it("bounds the ESCAPED length, not the input length", () => {
    expect(mrkdwnLabel("&".repeat(3000), 200).length).toBeLessThanOrEqual(200)
    expect(mrkdwnLabel("x".repeat(3000), 200).length).toBeLessThanOrEqual(200)
    expect(mrkdwnLabel("<!channel>", 200)).toBe("&lt;!channel&gt;")
    expect(mrkdwnLabel("Q4 plan", 200)).toBe("Q4 plan")
  })

  it("leaves no half-written entity at its boundary", () => {
    for (let max = 4; max <= 60; max++) {
      const out = mrkdwnLabel("&".repeat(40), max)
      expect(out.length).toBeLessThanOrEqual(max)
      expect(out).not.toMatch(/&[a-z]*$/)
    }
  })
})

// Slack's own guidance for user-supplied text. With verbatim unset (it defaults to false) Slack
// auto-links URLs, link-ifies conversation names, and parses certain mentions — so untrusted text
// can still produce a mention through a path our escaping never sees, because we never wrote a
// `<…>` for it at all. Escaping covers the explicit form; verbatim covers the auto-parsed one.
describe("block text objects opt out of Slack's automatic parsing", () => {
  it("sets verbatim on every mrkdwn text object we build", () => {
    expect(section("hi")).toMatchObject({ text: { type: "mrkdwn", verbatim: true } })
    expect(context("hi")).toMatchObject({ elements: [{ type: "mrkdwn", verbatim: true }] })
  })
})

// Fidelity gaps found by rendering a real review comment into a live workspace: our own
// escaping killed markdown block quotes (mrkdwn supports them), and markdown's `~~x~~` is not
// mrkdwn's `~x~`.
describe("mrkdwnBody — constructs mrkdwn supports but escaping was eating", () => {
  it("still escapes a > that is NOT a block-quote marker", () => {
    expect(mrkdwnBody("a > b")).toBe("a &gt; b")
    expect(mrkdwnBody("Foo<Bar> x")).toBe("Foo&lt;Bar&gt; x")
  })

  // The safety argument for unescaping a line-leading `>`: every `<` is escaped, so a lone `>`
  // has nothing to close. Control syntax must stay inert next to, and inside, a quote.
  it("keeps control syntax inert around a block quote", () => {
    expect(mrkdwnBody("<!channel>\n> quote")).toBe("&lt;!channel&gt;\n> quote")
    expect(mrkdwnBody("> <!channel>")).toBe("> &lt;!channel&gt;")
    expect(mrkdwnBody("> <@U1> and <!here>")).toBe("> &lt;@U1&gt; and &lt;!here&gt;")
  })
})

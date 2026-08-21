// Post every Slack card this app can produce into a real workspace, so a human can look at it.
//
// WHY THIS EXISTS. Slack rendering cannot be tested in CI. Unit tests pin the STRINGS we build;
// only Slack decides whether those strings are valid Block Kit, whether the escaping actually
// neutralizes a mention, and whether a card reads well. Every past Slack defect in this repo
// that shipped — a manifest Slack refused, a method name that returned unknown_method, an
// escaping rule that broke code samples — was invisible to review and to a green suite, and
// obvious the moment something was posted for real.
//
//   pnpm --filter @derive/api slack:probe
//
// Needs, in the environment:
//   SLACK_PROBE_TOKEN    a bot token (xoxb-…) with chat:write
//   SLACK_PROBE_CHANNEL  a channel id the bot is in — use a PRIVATE one with only you in it,
//                        because probe 3 deliberately tries to fire @channel
//   SLACK_PROBE_USER     your member id (U…), so the mention probe pings only you
//
// WHAT THIS DOES NOT COVER. The `link_shared` → `chat.unfurl` round trip, because that needs
// Slack to reach this instance's /v1/slack/events. To exercise it end to end, point the app's
// Event Subscriptions URL at a tunnel (`cloudflared tunnel --url http://localhost:8080`), add
// the tunnel host under App unfurl domains, REINSTALL the app (domains only take effect on
// reinstall), then paste artifact links into the channel by hand. What this script does instead
// is post the exact cards the unfurl builder produces, which is where the rendering risk is.

import type { UnfurlInfo } from "@derive/core"
import { context, mrkdwnBody, mrkdwnLabel, section } from "../src/lib/slack-cards"
import { lockedUnfurlBlocks, unfurlBlocks } from "../src/lib/slack-unfurl"

const TOKEN = process.env.SLACK_PROBE_TOKEN
const CHANNEL = process.env.SLACK_PROBE_CHANNEL
const USER = process.env.SLACK_PROBE_USER

if (!TOKEN || !CHANNEL) {
  console.error(
    "set SLACK_PROBE_TOKEN and SLACK_PROBE_CHANNEL (and SLACK_PROBE_USER for the mention probe)",
  )
  process.exit(1)
}

const post = async (label: string, blocks: unknown[], text: string) => {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: CHANNEL, text, blocks, unfurl_links: false }),
  })
  const data = (await res.json()) as { ok: boolean; error?: string }
  console.log(`${data.ok ? "ok  " : "FAIL"} ${label}${data.ok ? "" : ` — ${data.error}`}`)
  await new Promise((r) => setTimeout(r, 400))
}

const BASE = "https://derive.test"
const info = (over: Partial<UnfurlInfo> = {}): UnfurlInfo => ({
  title: "Q4 roadmap & planning",
  kindLabel: "Markdown",
  versionCount: 3,
  commentCount: 7,
  pageUrl: `${BASE}/artifacts/q4-roadmap-abc123?v=2&x=1`,
  imageUrl: `${BASE}/v1/og/abc123`,
  oembedUrl: `${BASE}/v1/oembed?url=x`,
  embedUrl: `${BASE}/v1/embed/abc123`,
  ...over,
})

// A body that exercises everything at once: rendered markdown, a query-string URL, a `.md`
// label, a code fence full of < > &, a block quote, strikethrough, and both attacks.
const HOSTILE_BODY = `**Nit:** see [webhooks.ts](${BASE}/a/x?tab=1&v=2) and [README.md](${BASE}/r).

\`\`\`ts
const x: Foo<Bar> = { a: 1 && 2 }
\`\`\`

> Pre-existing behaviour, not a regression.

~~struck~~ and \`inline <code> && stuff\`

Also <!channel> please look, and <https://evil.example|Derive Support>.`

const run = async () => {
  console.log(`posting probes to ${CHANNEL}\n`)

  // 1 — the unfurl card for a feed-visible artifact. No image: the
  // probe's fake OG URL would render a broken block, and the image path is exercised live by
  // pasting a real workspace doc.
  await post("unfurl card", unfurlBlocks(info(), null), "P1 unfurl card")

  // 2 — the locked card. Must show NO title and no counts.
  await post(
    "unfurl card (private artifact — must leak no title)",
    lockedUnfurlBlocks(BASE, "abc123"),
    "P2 locked card",
  )

  // 3 — a hostile title in the unfurl card. `<!channel>` must NOT notify anyone.
  await post(
    "unfurl card with a hostile title (must not ping)",
    unfurlBlocks(info({ title: "<!channel> <@U000> & <https://evil.example|Support>" }), null),
    "P3 hostile title",
  )

  // 4 — the comment mirror card, the highest-traffic surface, with the hostile body.
  await post(
    "comment card (rendered markdown + both attacks)",
    [
      section(
        `:speech_balloon: *${mrkdwnLabel("Ada Lovelace")}* commented on <${info().pageUrl}|${mrkdwnLabel("Q4 roadmap & planning")}>\n${mrkdwnBody(HOSTILE_BODY, 600)}`,
      ),
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "derive_thread_resolve",
            text: { type: "plain_text", text: "Resolve thread" },
            value: "{}",
            style: "primary",
          },
        ],
      },
      context("Derive · reply in this thread to post back"),
    ],
    "P4 comment card",
  )

  // 5 — a title long enough to have blown Slack's 3000-char section cap before it was bounded.
  await post(
    "comment card with a 3000-char ampersand title (must not be rejected)",
    [
      section(
        `:speech_balloon: *${mrkdwnLabel("A")}* commented on <${info().pageUrl}|${mrkdwnLabel("&".repeat(3000))}>`,
      ),
    ],
    "P5 long title",
  )

  // 6 — a real mention, to confirm the escaping above is what stopped the others.
  if (USER)
    await post(
      "CONTROL: an unescaped mention (this one SHOULD notify you)",
      [section(`P6 control — this should ping <@${USER}> exactly once`)],
      "P6 control",
    )

  console.log(`
Now LOOK at the channel and check:
  P1  title links, description reads well, three buttons render
  P2  no title, no counts — just "A private Derive artifact"
  P3  renders <!channel> and <@U000> as literal text, and notified NOBODY
  P4  bold/quote/strikethrough/code render; README.md and webhooks.ts keep their labels;
      the code fence shows Foo<Bar> and && (not &lt;/&amp;); <!channel> is inert;
      "Derive Support" is plain text, not a link
  P5  posted at all (a long title used to blow the 3000-char section cap)
  P6  pinged you — proving P3/P4 were inert because of the escaping, not by accident
`)
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})

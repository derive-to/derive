import { Buffer } from "node:buffer"
import type { Route } from "@playwright/test"
import { expect, openArtifact, test } from "./fixtures"

// The activity stream is the union of sources that settle at different times (versions,
// comments, review rounds — each gated on the session). It must paint ONCE, complete: a
// partial stream is a different stream (a card splits a turn, an ask lands between two
// publishes), and the open-scroll and "N new" logic would run against the wrong picture.
// Reproduced by a cold cache plus production-like latency, then sampled across the reload.
test("a cold reload paints the activity stream once, complete and in order", async ({
  owner: page,
}) => {
  let shortId = ""
  const html = (v: number) => `<h1>Doc v${v}</h1><p id="p1">Paragraph one.</p><p id="p2">Two.</p>`
  await expect(async () => {
    const res = await page.request.post("/v1/artifacts", {
      multipart: {
        file: { name: "doc.html", mimeType: "text/html", buffer: Buffer.from(html(1)) },
      },
    })
    expect(res.ok()).toBeTruthy()
    shortId = ((await res.json()) as { short_id: string }).short_id
  }).toPass({ timeout: 10_000 })
  const post = async (data: Record<string, unknown>) =>
    (await (await page.request.post(`/v1/artifacts/${shortId}/comments`, { data })).json()) as {
      id: string
      thread_id: string
    }
  const t1 = await post({
    body_md: "First thread",
    anchor: { type: "TextQuoteSelector", exact: "Paragraph one." },
  })
  await post({ thread_id: t1.thread_id, body_md: "A reply" })
  const t2 = await post({ body_md: "Second thread" })
  await page.request.post(`/v1/artifacts/${shortId}/comments/${t2.id}/resolve`, {
    data: { state: "resolved" },
  })
  for (const v of [2, 3]) {
    const r = await page.request.post(`/v1/artifacts/${shortId}/versions`, {
      multipart: {
        file: { name: "doc.html", mimeType: "text/html", buffer: Buffer.from(html(v)) },
        message: `v${v}`,
      },
    })
    expect(r.ok()).toBeTruthy()
  }
  await openArtifact(page, shortId)
  await page.waitForTimeout(800)

  // A last visit a minute ago arms the marker and the arrivals logic (set at document
  // start, so the reload's own pagehide stamp can't overwrite it).
  await page.addInitScript(
    (id) => localStorage.setItem(`derive.activity.seen.${id}`, String(Date.now() - 60_000)),
    shortId,
  )
  // Production latency, staggered the way the gates stagger it.
  const delay = (ms: number) => async (route: Route) => {
    await new Promise((r) => setTimeout(r, ms))
    await route.continue()
  }
  await page.route("**/v1/me", delay(150))
  await page.route("**/v1/artifacts/*/comments*", delay(300))
  await page.route("**/v1/artifacts/*/review", delay(500))
  // Cold: no persisted cache to paint from.
  await page.evaluate(async () => {
    for (const db of await indexedDB.databases())
      if (db.name)
        await new Promise((r) => {
          const q = indexedDB.deleteDatabase(db.name as string)
          q.onsuccess = q.onerror = q.onblocked = () => r(null)
        })
  })
  await page.reload()

  const orders: string[] = []
  let pill = false
  const t0 = Date.now()
  while (Date.now() - t0 < 2500) {
    const ids = await page
      .evaluate(() =>
        Array.from(
          document.querySelectorAll(
            '[data-testid="activity-stream"] [data-thread-id], [data-testid="activity-stream"] [data-testid^="resolved-thread-"], [data-testid="activity-stream"] [data-testid="activity-turn-toggle"], [data-testid="activity-stream"] [data-testid="activity-unread-marker"]',
          ),
        )
          .map((el) => el.getAttribute("data-thread-id") ?? el.getAttribute("data-testid") ?? "?")
          .join(" | "),
      )
      .catch(() => "")
    if (ids && orders[orders.length - 1] !== ids) orders.push(ids)
    if (
      await page
        .getByTestId("activity-jump-latest")
        .isVisible()
        .catch(() => false)
    )
      pill = true
    await page.waitForTimeout(50)
  }
  // One paint, already complete: marker, v1 turn, the anchored card, the folded resolved
  // thread, the v2–v3 turn. Never a versions-only first frame that reflows.
  expect(orders, orders.join("\n")).toHaveLength(1)
  expect(orders[0]).toMatch(
    /^activity-unread-marker \| activity-turn-toggle \| c_\w+ \| resolved-thread-c_\w+ \| activity-turn-toggle$/,
  )
  expect(pill).toBe(false)
})

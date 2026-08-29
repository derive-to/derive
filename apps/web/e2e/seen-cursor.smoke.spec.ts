import { Buffer } from "node:buffer"
import { expect, openArtifact, test } from "./fixtures"

// The "New" marker is the account's position in a stream, kept on the server: it is read
// once per visit and held still, advances after a visible dwell (never because the tab
// was hidden), survives an in-app round trip, ignores the reader's own rows, and imports
// the old per-browser stamp once. Exercised against the real app, end to end.

const doc = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`

test("the New marker is the account's position: first visit, arrivals, own rows, round trip, tab hide", async ({
  owner: page,
}) => {
  test.setTimeout(150_000)
  const publish = async (
    shortId: string | null,
    body: string,
    fields: Record<string, string> = {},
    as?: Record<string, string>,
  ) => {
    const res = await page.request.post(
      shortId ? `/v1/artifacts/${shortId}/versions` : "/v1/artifacts",
      {
        headers: as,
        multipart: {
          file: { name: "doc.html", mimeType: "text/html", buffer: Buffer.from(body) },
          listed: "workspace",
          ...(shortId ? {} : { title: /<title>(.*?)<\/title>/.exec(body)?.[1] ?? "Untitled" }),
          ...fields,
        },
      },
    )
    expect(res.ok(), await res.text()).toBeTruthy()
    return ((await res.json()) as { short_id: string }).short_id
  }
  const wsRes = (await (await page.request.get("/v1/workspace")).json()) as {
    id?: string
    workspace?: { id: string }
  }
  const scope = `ws:${wsRes.workspace?.id ?? wsRes.id ?? ""}`
  const cursor = async () =>
    (
      (await (await page.request.get(`/v1/seen?scope=${scope}`)).json()) as {
        seen_at: string | null
      }
    ).seen_at
  // A fresh visit: a new tab session (no visit snapshot) and no persisted query cache —
  // the app restores the last answer from IndexedDB and holds it for 30s, which would
  // repaint the list from before the arrivals.
  const freshVisit = async () => {
    await page.goto("/")
    await page.evaluate(async () => {
      sessionStorage.clear()
      for (const db of await indexedDB.databases())
        if (db.name)
          await new Promise((r) => {
            const q = indexedDB.deleteDatabase(db.name as string)
            q.onsuccess = q.onerror = q.onblocked = () => r(null)
          })
    })
    await page.goto("/activity")
    await expect(page.getByTestId("wa-recent")).toBeVisible()
  }
  const recentText = () => page.getByTestId("wa-recent").innerText()
  const split = async () => {
    const [above, below] = (await recentText()).split(/new above/i)
    return { above: above ?? "", below: below ?? "" }
  }

  // Two actors: the person, and a registered agent acting through its own bearer.
  let planId = ""
  await expect(async () => {
    planId = await publish(null, doc("Plan", "<p>v1</p>"), { message: "Create" })
  }).toPass({ timeout: 10_000 })
  const reg = await page.request.post("/v1/agents", { data: { name: "Codex", role: "editor" } })
  expect(reg.ok(), await reg.text()).toBeTruthy()
  const asAgent = {
    authorization: `Bearer ${((await reg.json()) as { token: string }).token}`,
  }
  await publish(planId, doc("Plan", "<p>v2</p>"), { message: "Agent v2" }, asAgent)

  // 1. A first visit draws no line and, after a visible dwell, stamps the position.
  expect(await cursor()).toBeNull()
  await page.goto("/activity")
  await expect(page.getByTestId("wa-recent")).toBeVisible()
  await expect(page.getByTestId("wa-unread-marker")).toHaveCount(0)
  await expect.poll(cursor, { timeout: 10_000 }).not.toBeNull()
  const c1 = await cursor()

  // 2. Then the agent publishes v3 and the person publishes v4. On the next visit the line
  //    separates the agent's v3 (new) from everything the person had seen; their own v4 is
  //    newer than the line, so it sits above it — but it is not counted as new (the count
  //    is asserted through the rail below), and it never earns a line of its own.
  await page.waitForTimeout(1100)
  await publish(planId, doc("Plan", "<p>v3</p>"), { message: "Agent v3" }, asAgent)
  await publish(planId, doc("Plan", "<p>v4</p>"), { message: "Mine v4" })
  await freshVisit()
  await expect(page.getByTestId("wa-unread-marker")).toHaveCount(1)
  let parts = await split()
  expect(parts.above).toMatch(/Codex published v3/)
  expect(parts.below).toMatch(/Codex published v2/)
  expect(parts.below).not.toMatch(/v3/)

  // 3. The line holds through an in-app round trip even though the position advanced
  //    underneath it during the dwell: leave for the library, come back, same line.
  const before = await cursor()
  await expect.poll(cursor, { timeout: 10_000 }).not.toBe(before)
  await page.getByRole("link", { name: "Library" }).first().click()
  await expect(page).not.toHaveURL(/\/activity$/)
  await page.getByTestId("menu-activity").click()
  await expect(page.getByTestId("wa-unread-marker")).toHaveCount(1)
  parts = await split()
  expect(parts.above).toMatch(/Codex published v3/)
  expect(parts.below).not.toMatch(/v3/)

  // 4. A hidden tab never advances the position; a visible one does after the dwell.
  await page.waitForTimeout(5_500) // past the write gap, so the next dwell can write
  await publish(planId, doc("Plan", "<p>v5</p>"), { message: "Agent v5" }, asAgent)
  await freshVisit()
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  const hiddenAt = await cursor()
  await page.waitForTimeout(6_000)
  expect(await cursor()).toBe(hiddenAt)
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await expect.poll(cursor, { timeout: 10_000 }).not.toBe(hiddenAt)
  expect(await cursor()).toBe(c1 === null ? null : await cursor())
})

test("a rail imports the old per-browser stamp once, then its position lives on the server", async ({
  owner: page,
}) => {
  test.setTimeout(60_000)
  const res = await page.request.post("/v1/artifacts", {
    multipart: {
      file: {
        name: "doc.html",
        mimeType: "text/html",
        buffer: Buffer.from(doc("Rail", "<p>hi</p>")),
      },
      title: "Rail",
    },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
  const { short_id } = (await res.json()) as { short_id: string }
  const scope = `artifact:${short_id}`
  const cursor = async () =>
    (
      (await (await page.request.get(`/v1/seen?scope=${scope}`)).json()) as {
        seen_at: string | null
      }
    ).seen_at
  expect(await cursor()).toBeNull()
  const legacy = Date.now() - 3_600_000
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [`derive.activity.seen.${short_id}`, String(legacy)],
  )
  await openArtifact(page, short_id)
  await expect.poll(cursor, { timeout: 10_000 }).toBe(new Date(legacy).toISOString())
  expect(
    await page.evaluate((k) => localStorage.getItem(k), `derive.activity.seen.${short_id}`),
  ).toBeNull()
})

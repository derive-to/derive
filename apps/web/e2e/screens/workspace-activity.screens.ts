import { Buffer } from "node:buffer"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { Route } from "@playwright/test"
import { expect, test } from "../fixtures"

// Visual-QA capture for the ACTIVITY page ("Needs you" + "Recent activity"):
// seeds a workspace with a person's documents, a registered agent that publishes, asks
// for review, replies and resolves, then captures the page resting, a turn opened, the
// folded Needs-you groups, dark mode, the loading frame, and where Answer lands. Not a
// test gate: self-skips unless SHOTS=1.
//   SHOTS=1 SHOT_DIR=/tmp/shots npx playwright test --project=screens e2e/screens/workspace-activity.screens.ts
test.skip(() => process.env.SHOTS !== "1", "visual capture harness — set SHOTS=1 to run")

const OUT = process.env.SHOT_DIR ?? join(process.cwd(), "test-results", "screens")
mkdirSync(OUT, { recursive: true })

const doc = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font:17px/1.6 system-ui;padding:40px;max-width:640px"><h1>${title}</h1>${body}</body></html>`

test("capture workspace activity states", async ({ owner: page }) => {
  // A publish by the signed-in person, or — with `as` — by a registered agent's bearer.
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
  const comment = async (
    shortId: string,
    body_md: string,
    extra: Record<string, unknown> = {},
    as?: Record<string, string>,
  ) => {
    const res = await page.request.post(`/v1/artifacts/${shortId}/comments`, {
      headers: as,
      data: { body_md, ...extra },
    })
    expect(res.ok(), await res.text()).toBeTruthy()
    return (await res.json()) as { id: string; thread_id: string }
  }

  // The person's documents.
  let narrative = ""
  await expect(async () => {
    narrative = await publish(
      null,
      doc("Q3 Growth Narrative", "<p id=p1>Q2 closed with activation at 41%.</p>"),
      { message: "Create" },
    )
  }).toPass({ timeout: 10_000 })
  await publish(
    narrative,
    doc(
      "Q3 Growth Narrative",
      "<p id=p1>Q2 closed with activation at 41%, three points above plan.</p>",
    ),
    { message: "Add the plan delta" },
  )
  await publish(
    narrative,
    doc(
      "Q3 Growth Narrative",
      "<p id=p1>Q2 closed with activation at 41%, three points above plan. Retention did not follow.</p>",
    ),
    { message: "Add retention" },
  )
  const pricing = await publish(null, doc("Pricing page test", "<p>Two variants, one week.</p>"), {
    message: "Create",
  })
  const onboarding = await publish(
    null,
    doc("Onboarding metrics", "<p>Time to first artifact.</p>"),
    { message: "Create" },
  )

  // The person's threads: one the agent will answer and resolve, one settled by hand.
  const capacity = await comment(
    narrative,
    "Do we have the sales capacity for this in Q3? Feels like a Q4 bet.",
    {
      anchor: { type: "TextQuoteSelector", exact: "three points above plan" },
    },
  )
  const typo = await comment(narrative, "Typo in the second paragraph.")
  await page.request.post(`/v1/artifacts/${narrative}/comments/${typo.id}/resolve`, {
    data: { state: "resolved" },
  })

  // A REAL agent, registered here and acting through its own bearer.
  const reg = await page.request.post("/v1/agents", {
    data: { name: "Claude Code", role: "editor" },
  })
  expect(reg.ok(), await reg.text()).toBeTruthy()
  const agent = (await reg.json()) as { id: string; token: string }
  const asAgent = { authorization: `Bearer ${agent.token}` }

  // It replies in the person's thread, publishes a version that resolves it and asks for
  // review, then works two more documents and asks on each.
  await comment(
    narrative,
    "Checked the pipeline: two named accounts are already in late stage, so Q3 holds.",
    { thread_id: capacity.thread_id },
    asAgent,
  )
  await publish(
    narrative,
    doc(
      "Q3 Growth Narrative",
      "<p id=p1>Q2 closed with activation at 41%, three points above plan. Retention did not follow.</p><p>Two named accounts are in late stage; Q3 holds.</p>",
    ),
    {
      message: "Answer the capacity question in the narrative",
      resolves: capacity.id,
      request_review: "true",
      review_note:
        "Folded the capacity answer into the narrative and closed the thread. Does the framing read right?",
    },
    asAgent,
  )
  await publish(
    pricing,
    doc("Pricing page test", "<p>Two variants, one week. Variant B leads by 4 points.</p>"),
    {
      message: "Add the interim result",
      request_review: "true",
      review_note: "Interim result added — call it early, or wait the week?",
    },
    asAgent,
  )
  await publish(
    onboarding,
    doc("Onboarding metrics", "<p>Time to first artifact: 6 minutes.</p>"),
    { message: "Fill in the number" },
    asAgent,
  )
  // More asks, so the group folds.
  for (const n of [1, 2, 3, 4]) {
    const id = await publish(null, doc(`Weekly digest #${n}`, "<p>Draft.</p>"), {
      message: "Create",
    })
    await publish(
      id,
      doc(`Weekly digest #${n}`, "<p>Draft, with this week's numbers.</p>"),
      { message: "Fill in the week", request_review: "true" },
      asAgent,
    )
  }
  // The person has seen everything so far: their position in the workspace stream is set
  // on the server (a manual write lands regardless of any dwell), so what follows — the
  // thread that tags them — is what "New above" separates. The next arrival must be
  // strictly newer than the stamp.
  const wsRes = (await (await page.request.get("/v1/workspace")).json()) as {
    id?: string
    workspace?: { id: string }
  }
  const wsId = wsRes.workspace?.id ?? wsRes.id ?? ""
  const seeded = await page.request.put("/v1/seen", {
    data: { scope: `ws:${wsId}`, at: new Date().toISOString(), manual: true },
  })
  expect(seeded.ok()).toBeTruthy()
  await page.waitForTimeout(1100)
  // Someone tags the person in a thread on the pricing test.
  const meRes = (await (await page.request.get("/v1/me")).json()) as {
    id?: string
    name?: string
    user?: { id: string; name: string }
  }
  const me = meRes.user ?? { id: meRes.id ?? "", name: meRes.name ?? "" }
  await comment(
    pricing,
    "@you should this wait for the full week?",
    { mentions: [{ id: me.id, name: me.name }] },
    asAgent,
  )

  const shoot = (name: string) => page.screenshot({ path: `${OUT}/${name}.png` })
  await page.evaluate(() => localStorage.setItem("derive_theme", "light"))
  // The sign-in painted the rail's Activity count from an empty workspace and persisted
  // that answer; drop it so this visit reads the seeded workspace (a person's own reload
  // refreshes within 30s anyway).
  await page.goto("/")
  await page.evaluate(async () => {
    for (const db of await indexedDB.databases())
      if (db.name)
        await new Promise((r) => {
          const q = indexedDB.deleteDatabase(db.name as string)
          q.onsuccess = q.onerror = q.onblocked = () => r(null)
        })
  })
  await page.evaluate(() => sessionStorage.clear())
  await page.goto("/activity")
  await expect(page.getByTestId("wa-needs-you")).toBeVisible()
  await expect(page.getByTestId("wa-recent")).toBeVisible()
  await page.waitForTimeout(800)
  await shoot("activity-page-light")
  // A turn opened: the versions and the ask behind one line.
  await page.getByTestId("activity-turn-toggle").first().click()
  await page.waitForTimeout(300)
  await shoot("activity-page-turn-open")
  await page.getByTestId("activity-turn-toggle").first().click()
  // The folded group, unfolded.
  await page.getByTestId("wa-needs-more-asks").click()
  await page.waitForTimeout(300)
  await shoot("activity-page-needs-more")
  // Dark.
  await page.evaluate(() => localStorage.setItem("derive_theme", "dark"))
  await page.reload()
  await expect(page.getByTestId("wa-recent")).toBeVisible()
  await page.waitForTimeout(800)
  await shoot("activity-page-dark")
  // The loading frame: a cold cache and a slow request.
  await page.evaluate(() => localStorage.setItem("derive_theme", "light"))
  const delay = (ms: number) => async (route: Route) => {
    await new Promise((r) => setTimeout(r, ms))
    await route.continue().catch(() => {})
  }
  await page.route("**/v1/workspace/activity*", delay(2500))
  await page.evaluate(async () => {
    for (const db of await indexedDB.databases())
      if (db.name)
        await new Promise((r) => {
          const q = indexedDB.deleteDatabase(db.name as string)
          q.onsuccess = q.onerror = q.onblocked = () => r(null)
        })
  })
  await page.reload()
  await expect(page.getByTestId("activity-stream-loading")).toBeVisible({ timeout: 5000 })
  await page.waitForTimeout(200)
  await shoot("activity-page-loading")
  await expect(page.getByTestId("wa-recent")).toBeVisible({ timeout: 10_000 })
  await page.unroute("**/v1/workspace/activity*")
  // Answer lands on the document with the composer armed.
  await page.getByTestId("wa-ask-answer").first().click()
  await expect(page.getByTestId("review-send-back")).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(800)
  await shoot("activity-page-answer-lands")
  // A phone: the same page in one column; rows truncate, the action stays on the line.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/activity")
  await expect(page.getByTestId("wa-needs-you")).toBeVisible()
  await page.waitForTimeout(600)
  await shoot("activity-page-mobile")
})

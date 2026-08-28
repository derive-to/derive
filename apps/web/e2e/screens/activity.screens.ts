import { Buffer } from "node:buffer"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, openArtifact, test } from "../fixtures"

// Visual-QA capture for the ACTIVITY rail (the comments harness's sibling): seeds a
// document with several versions (turns), threads including a resolved one, and a
// pending review round, then captures the resting rail, an opened turn, the answering
// composer, the Changes lens, and dark mode. Not a test gate: self-skips unless
// SHOTS=1, so a bare `playwright test` ignores it.
//   SHOTS=1 SHOT_DIR=/tmp/shots npx playwright test --project=screens e2e/screens/activity.screens.ts
test.skip(() => process.env.SHOTS !== "1", "visual capture harness — set SHOTS=1 to run")

const OUT = process.env.SHOT_DIR ?? join(process.cwd(), "test-results", "screens")
mkdirSync(OUT, { recursive: true })

const doc = (
  extra: string,
) => `<!doctype html><html><head><meta charset="utf-8"><title>Q3 narrative</title></head>
<body style="font:17px/1.7 system-ui;padding:40px;max-width:620px">
<h1>Q3 Growth Narrative</h1>
<p id="p1">Q2 closed with new-workspace activation at 41%, three points above plan. Retention did not follow.</p>
<p id="p2">We keep weekly active workspaces with a published artifact as the north-star metric.</p>
<p id="p3">Two named accounts and a pricing page test to expand into the mid-market segment before Q4.</p>
${extra}
</body></html>`

test("capture activity rail states", async ({ owner: page }) => {
  let shortId = ""
  // A publish by the signed-in person, or — with `as` — by a registered agent's bearer.
  const publish = async (
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
          ...fields,
        },
      },
    )
    expect(res.ok(), await res.text()).toBeTruthy()
    const json = (await res.json()) as { short_id: string }
    shortId = json.short_id
  }
  await expect(async () => {
    await publish(doc(""), { message: "Create" })
  }).toPass()
  await publish(doc("<p>Risks: the invite change touches the most-used flow.</p>"), {
    message: "Rewrite the risks section",
  })
  await publish(doc("<p>Risks: the invite change ships behind a flag.</p>"), {
    message: "Ship the invite change behind a flag",
  })

  const comment = async (body_md: string, anchor?: Record<string, unknown>) => {
    const res = await page.request.post(`/v1/artifacts/${shortId}/comments`, {
      data: { body_md, anchor },
    })
    expect(res.ok(), await res.text()).toBeTruthy()
    return (await res.json()) as { id: string }
  }
  const settled = await comment("Is this the same definition Finance uses?", {
    type: "TextQuoteSelector",
    exact: "north-star metric",
  })
  await page.request.post(`/v1/artifacts/${shortId}/comments/${settled.id}/resolve`, {
    data: { state: "resolved" },
  })
  const openThread = await comment(
    "Do we have the sales capacity for this in Q3? Feels like a Q4 bet.",
    { type: "TextQuoteSelector", exact: "expand into the mid-market segment" },
  )

  // Now a REAL agent: registered in this workspace, acting through its own bearer. It
  // replies in the open thread, then publishes a version that asks for review — the loop.
  // Editor, not the default commenter: publishing is what the loop is about.
  const reg = await page.request.post("/v1/agents", {
    data: { name: "Claude Code", role: "editor" },
  })
  expect(reg.ok(), await reg.text()).toBeTruthy()
  const agent = (await reg.json()) as { id: string; token: string }
  const asAgent = { authorization: `Bearer ${agent.token}` }
  const reply = await page.request.post(`/v1/artifacts/${shortId}/comments`, {
    headers: asAgent,
    data: {
      body_md: "Checked the pipeline: two named accounts are already in late stage, so Q3 holds.",
      thread_id: openThread.id,
    },
  })
  expect(reply.ok(), await reply.text()).toBeTruthy()
  await publish(
    doc("<p>Risks: the invite change ships behind a flag, per workspace.</p>"),
    {
      message: "Recompute churn from the dashboard export",
      request_review: "true",
      review_note:
        "Recomputed churn from the export: 4.1% → 4.6%. A human should confirm the reactivation rule.",
    },
    asAgent,
  )

  await openArtifact(page, shortId)
  await expect(page.getByTestId("review-send-back")).toBeVisible()
  await page.waitForTimeout(1200)
  const shoot = (name: string) => page.screenshot({ path: `${OUT}/${name}.png` })
  await shoot("activity-light")

  // Open the newest turn (the publish + the pending ask).
  await page.getByTestId("activity-turn-toggle").last().click()
  await page.waitForTimeout(300)
  await shoot("activity-turn-open")

  // The Comments lens is the old panel: threads only.
  await page.getByTestId("activity-lens").click()
  await page.getByTestId("activity-lens-comments").click()
  await page.waitForTimeout(300)
  await shoot("activity-comments-lens")
  await page.getByTestId("activity-lens").click()
  await page.getByTestId("activity-lens-all").click()

  // Answer the round from the composer.
  await page.getByTestId("review-send-note").fill("Reactivation rule is right — good to go.")
  await page.waitForTimeout(200)
  await shoot("activity-answering")
  await page.getByTestId("review-send-back").click()
  await expect(page.getByTestId("review-send-back")).toHaveCount(0)
  await page.waitForTimeout(600)
  await shoot("activity-sent-back")

  // A resolved thread is one line that unfolds into its (muted) card.
  await page.getByTestId(`resolved-thread-${settled.id}`).click()
  await expect(page.getByTestId("comment-card")).toHaveCount(2)
  await page.waitForTimeout(300)
  await shoot("activity-resolved-open")
  await page.getByTestId(`resolved-thread-${settled.id}`).click()

  // Dark theme.
  await page.evaluate(() => localStorage.setItem("derive_theme", "dark"))
  await page.reload()
  await expect(page.getByTestId("activity-stream")).toBeVisible()
  await page.waitForTimeout(1200)
  await shoot("activity-dark")

  // The Activity page: the same records as the workspace's "Needs you" (the agent's ask,
  // the open thread) and "Recent activity" (the folded turns), newest first.
  await page.goto("/activity")
  await expect(page.getByTestId("wa-needs-you")).toBeVisible()
  await expect(page.getByTestId("wa-recent")).toBeVisible()
  await page.waitForTimeout(600)
  await shoot("activity-page")
  await page.goto(`/artifacts/${shortId}`)
  await expect(page.getByTestId("activity-stream")).toBeVisible()

  // A phone: the same stream in the docked sheet, and a round answered from its bar.
  await page.evaluate(() => localStorage.setItem("derive_theme", "light"))
  await page.setViewportSize({ width: 390, height: 844 })
  await publish(
    doc("<p>Risks: reviewed again.</p>"),
    {
      message: "Tighten the risks wording",
      request_review: "true",
      review_note: "One more look at the risks paragraph, please.",
    },
    asAgent,
  )
  await page.reload()
  await page.getByTestId("comments-sheet-resize").click()
  await expect(page.getByTestId("activity-stream")).toBeVisible()
  await page.waitForTimeout(800)
  await shoot("activity-mobile")
  await page.getByTestId("review-answer").first().click()
  await expect(page.getByTestId("review-send-back")).toBeVisible()
  await page.waitForTimeout(400)
  await shoot("activity-mobile-answering")
  await page.getByTestId("review-send-back").click()
  await expect(page.getByTestId("review-send-back")).toHaveCount(0)

  await page.request.delete(`/v1/agents/${agent.id}`)
})

import { Buffer } from "node:buffer"
import { request as pwRequest } from "@playwright/test"
import { expect, publishArtifact, shareArtifact, test } from "../fixtures"

// The ask loop, end-to-end through the console, with the runner stubbed as raw
// API calls carrying the agent's bearer (no model in tests — the e2e contract is
// the loop, not the answer). Owner wires the context; secondUser is the asker.
test("ask → stub-runner answer with meta → follow-up → close", async ({ owner, secondUser }) => {
  // Owner: agent + manifest + context, all via API (creation UI is exercised in
  // the console smoke below; this spec is about the loop).
  const agentRes = await owner.request.post("/v1/agents", {
    data: { name: "Analyst", role: "editor" },
  })
  expect(agentRes.ok()).toBeTruthy()
  const agent = await agentRes.json()

  const manifestShortId = await publishArtifact(owner, "Analytics manifest", "# Metric definitions")
  const ctxRes = await owner.request.post("/v1/contexts", {
    data: { name: "Analytics", agent_id: agent.id, manifest_short_id: manifestShortId },
  })
  expect(ctxRes.ok()).toBeTruthy()
  const ctx = await ctxRes.json()

  // The ask grant is the manifest's roster: share it with the asker.
  await shareArtifact(owner.request, manifestShortId, secondUser.email, "viewer")

  // Asker: open the console, ask.
  await secondUser.page.goto(`/contexts/${ctx.id}`)
  await secondUser.page.getByTestId("console-ask-input").fill("What was March churn?")
  await secondUser.page.getByTestId("console-ask-submit").click()
  await expect(secondUser.page.getByTestId("console-message")).toHaveCount(1)
  await expect(secondUser.page.getByTestId("console-waiting")).toBeVisible()

  // Stub runner: drain the queue with the agent bearer, answer with meta.
  const queue = await owner.request.get(`/v1/contexts/${ctx.id}/queue`, {
    headers: { authorization: `Bearer ${agent.token}` },
  })
  const { sessions } = await queue.json()
  expect(sessions).toHaveLength(1)
  expect(sessions[0].messages[0].body_md).toBe("What was March churn?")
  // The runner may attach published artifacts (the promotion channel) — the
  // console must render them as chips linking into the app. Publish it the way
  // the real runner does: the AGENT bearer on a cookie-less context, so the
  // token→registrant-ownership→link-visibility path is what's exercised.
  const agentReq = await pwRequest.newContext({ baseURL: new URL(owner.url()).origin })
  const chartRes = await agentReq.post("/v1/artifacts", {
    headers: { authorization: `Bearer ${agent.token}` },
    multipart: {
      file: { name: "chart.html", mimeType: "text/html", buffer: Buffer.from("<h1>chart</h1>") },
      title: "Churn by month",
      link_role: "viewer",
    },
  })
  expect(chartRes.ok()).toBeTruthy()
  const chartShortId = ((await chartRes.json()) as { short_id: string }).short_id
  await agentReq.dispose()
  await owner.request.post(`/v1/sessions/${sessions[0].id}/messages`, {
    headers: { authorization: `Bearer ${agent.token}` },
    data: {
      body_md: "March churn was **3.1%**.",
      meta: {
        query: "select churn from metrics",
        confidence: 0.9,
        caveats: ["30-day window"],
        artifacts: [{ short_id: chartShortId, title: "Churn by month" }],
      },
    },
  })

  // The console's open-state poll picks the answer up without a reload.
  await expect(secondUser.page.getByTestId("console-message")).toHaveCount(2)
  await expect(secondUser.page.getByText("March churn was")).toBeVisible()
  await expect(secondUser.page.getByText("confidence 90%")).toBeVisible()
  await expect(secondUser.page.getByText("30-day window")).toBeVisible()
  await secondUser.page.getByTestId("console-query-toggle").click()
  await expect(secondUser.page.getByText("select churn from metrics")).toBeVisible()
  await expect(secondUser.page.getByTestId("console-artifact-link")).toHaveText(/Churn by month/)

  // Follow-up re-opens (composer disables while the runner owes a reply).
  await secondUser.page.getByTestId("console-followup-input").fill("And February?")
  await secondUser.page.getByTestId("console-followup-submit").click()
  await expect(secondUser.page.getByTestId("console-message")).toHaveCount(3)
  await expect(secondUser.page.getByTestId("console-waiting")).toBeVisible()

  // Close ends the conversation.
  await secondUser.page.getByTestId("console-close-session").click()
  await expect(secondUser.page.getByText("This conversation is closed.")).toBeVisible()

  // The owner's activity tab sees the asker's session; a fresh visitor sees nothing.
  await owner.goto(`/contexts/${ctx.id}`)
  await owner.getByTestId("console-tab-activity").click()
  await expect(owner.getByTestId("console-activity-row")).toHaveCount(1)
})

test("the contexts page creates a context through the form", async ({ owner }) => {
  // An agent must exist for the form's agent select to have an option.
  await owner.request.post("/v1/agents", { data: { name: "FormBot" } })
  const manifestShortId = await publishArtifact(owner, "Form manifest", "# m")

  await owner.goto("/contexts")
  await owner.getByTestId("context-create-name").fill("Form context")
  // The agent select defaults to the only agent; fill the manifest and submit.
  await owner.getByTestId("context-create-manifest").fill(manifestShortId)
  await owner.getByTestId("context-create-submit").click()
  await expect(owner.getByTestId("context-card")).toHaveCount(1)
})

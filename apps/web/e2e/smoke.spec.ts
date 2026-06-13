import { Buffer } from "node:buffer"
import { expect, test } from "@playwright/test"

// The core loop, end to end through the real UI: sign up, publish an artifact,
// comment on it, and resolve the thread.
test("publish, comment, and resolve", async ({ page }) => {
  // A fresh database each run means this first user is the workspace owner.
  const email = `smoke+${Date.now()}@dock.test`

  await page.goto("/login")
  await page.getByRole("button", { name: "Create an account" }).click()
  await page.getByPlaceholder("Your name").fill("Smoke Tester")
  await page.getByPlaceholder("you@company.com").fill(email)
  await page.getByPlaceholder("At least 8 characters").fill("smoke-pass-123")
  await page.getByRole("button", { name: "Create account" }).click()

  // Signed in: redirected off the login page.
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })

  // Publish a markdown doc through the now-authenticated session.
  const md = "# Smoke Doc\n\nThe body of the smoke-test document for the comment loop."
  const res = await page.request.post("/v1/artifacts", {
    multipart: {
      file: { name: "smoke.md", mimeType: "text/markdown", buffer: Buffer.from(md) },
    },
  })
  expect(res.ok()).toBeTruthy()
  const { short_id: shortId } = (await res.json()) as { short_id: string }

  // Open it and add a comment from the panel.
  await page.goto(`/a/${shortId}`)
  await expect(page.getByText("Comments", { exact: true })).toBeVisible()
  await page.getByTitle("New comment").click()
  await page.getByPlaceholder("Add a comment…").fill("Looks good, shipping.")
  await page.getByRole("button", { name: "Comment", exact: true }).click()
  await expect(page.getByText("Looks good, shipping.")).toBeVisible()

  // Resolve the thread: activate the card, then resolve it.
  await page.getByText("Looks good, shipping.").click()
  await page.getByRole("button", { name: "Resolve" }).click()
  await expect(page.getByText(/Resolved \(\d+\)/)).toBeVisible()
})

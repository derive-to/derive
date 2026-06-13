import { Buffer } from "node:buffer"
import { expect, type Page } from "@playwright/test"

// Reusable building blocks for the e2e suite. The whole app is instrumented with
// stable `data-testid`s, so specs drive it through page.getByTestId(...) — no
// brittle text/role lookups that shift as copy or layout changes.

let seq = 0
const uniqueEmail = () => `e2e+${Date.now()}-${seq++}@dock.test`

// Fresh-DB signup. The first account on a throwaway database is the workspace
// owner, so this also seeds an authenticated session for everything downstream.
export async function signUp(page: Page, name = "E2E Tester"): Promise<string> {
  const email = uniqueEmail()
  await page.goto("/login")
  await page.getByRole("button", { name: "Create an account" }).click()
  await page.getByPlaceholder("Your name").fill(name)
  await page.getByPlaceholder("you@company.com").fill(email)
  await page.getByPlaceholder("At least 8 characters").fill("e2e-pass-1234")
  await page.getByRole("button", { name: "Create account" }).click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })
  return email
}

// Publish an artifact straight through the authenticated API and return its
// short id. Faster and less flaky than driving the file picker, and the UI
// reads the same data back.
export async function publishArtifact(
  page: Page,
  name = "doc.md",
  body = "# Doc\n\nbody text",
): Promise<string> {
  const res = await page.request.post("/v1/artifacts", {
    multipart: {
      file: { name, mimeType: "text/markdown", buffer: Buffer.from(body) },
    },
  })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { short_id: string }).short_id
}

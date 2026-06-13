import { Buffer } from "node:buffer"
import { expect, type Page } from "@playwright/test"

// Reusable building blocks for the e2e suite. The whole app is instrumented with
// stable `data-testid`s, so specs drive it through page.getByTestId(...) — no
// brittle text/role lookups that shift as copy or layout changes.

// Globally unique across parallel workers — a per-worker counter would collide
// between worker processes (each starts at 0), so use a UUID.
const uniqueEmail = () => `e2e+${crypto.randomUUID()}@dock.test`

// Fresh-DB signup. The first account on a throwaway database is the workspace
// owner, so this also seeds an authenticated session for everything downstream.
export async function signUp(page: Page, name = "E2E Tester"): Promise<string> {
  const email = uniqueEmail()
  await page.goto("/login")
  await page.getByTestId("login-toggle").click() // switch from sign-in to create-account
  await page.getByTestId("login-name").fill(name)
  await page.getByTestId("login-email").fill(email)
  await page.getByTestId("login-password").fill("e2e-pass-1234")
  await page.getByTestId("login-submit").click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })
  // Authenticated chrome is up (the header user menu renders on every page once
  // `me` resolves) — a deterministic "signed in and the app shell is ready" gate.
  await expect(page.getByTestId("user-menu-trigger")).toBeVisible()
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
  // Retry the publish: in multi-workspace mode a brand-new user's personal
  // workspace is provisioned lazily on first request, so the very first publish
  // can briefly race that. toPass re-issues it until it succeeds (eventual
  // consistency, not flake-masking) within a short window.
  let shortId = ""
  await expect(async () => {
    const res = await page.request.post("/v1/artifacts", {
      multipart: {
        file: { name, mimeType: "text/markdown", buffer: Buffer.from(body) },
      },
    })
    expect(res.ok(), `publish failed: ${res.status()}`).toBeTruthy()
    shortId = ((await res.json()) as { short_id: string }).short_id
  }).toPass({ timeout: 10_000 })
  return shortId
}

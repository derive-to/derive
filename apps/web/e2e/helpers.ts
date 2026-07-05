import { Buffer } from "node:buffer"
import { type APIRequestContext, expect, type Page } from "@playwright/test"

// Reusable building blocks for the e2e suite. The whole app is instrumented with
// stable `data-testid`s, so specs drive it through page.getByTestId(...) — no
// brittle text/role lookups that shift as copy or layout changes.

// Globally unique across parallel workers — a per-worker counter would collide
// between worker processes (each starts at 0), so use a UUID.
const uniqueEmail = () => `e2e+${crypto.randomUUID()}@derive.test`

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
  // A fresh account is routed to the dedicated onboarding step (/welcome, chrome-
  // less). Skip it so this helper returns with the app shell ready; tests that
  // exercise onboarding itself drive /welcome explicitly. The click auto-waits for
  // the step to render, absorbing the post-signup redirect timing.
  await page.getByTestId("welcome-skip").click()
  // Authenticated chrome is up — a deterministic "signed in and the app shell
  // is ready" gate. `library-menu` renders on every viewport (the rail's
  // trigger on desktop, the navbar hamburger on mobile); the user pod itself
  // lives inside the mobile drawer sheet, so it isn't visible here.
  await expect(page.getByTestId("library-menu")).toBeVisible()
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
        // Link-visible explicitly: most specs hand the artifact to a second user
        // or an anonymous page, which the private default would lock out. Specs
        // about the default itself publish without the helper.
        visibility: "link",
      },
    })
    expect(res.ok(), `publish failed: ${res.status()}`).toBeTruthy()
    shortId = ((await res.json()) as { short_id: string }).short_id
  }).toPass({ timeout: 10_000 })
  return shortId
}

// Open an artifact's page and wait for the comment panel to be ready — the
// deterministic "artifact view is interactive" gate every comment test needs.
export async function openArtifact(page: Page, shortId: string): Promise<void> {
  await page.goto(`/artifacts/${shortId}`)
  await expect(page.getByText("Comments", { exact: true })).toBeVisible()
}

// Post a top-level comment through the composer (all test-id driven) and wait
// for it to render. Returns nothing — assert on the body text in the caller.
export async function addComment(page: Page, body: string): Promise<void> {
  await page.getByTestId("comment-new").click()
  await page.getByTestId("composer-input").fill(body)
  await page.getByTestId("composer-submit").click()
  await expect(page.getByText(body)).toBeVisible()
}

// Open (activate) a comment thread by clicking its card, then wait for the
// expanded controls (the resolve button) to appear. A just-posted card can be
// mid entrance-animation, or re-rendering from the create refetch, exactly as
// the click lands — so the first click is occasionally absorbed before it
// registers. Re-clicking until the thread is open makes activation reliable
// (clicking an already-open card is a no-op, so the retry is safe).
export async function activateThread(page: Page, text: string): Promise<void> {
  await expect(async () => {
    await page.getByText(text).first().click()
    await expect(page.getByTestId("comment-resolve")).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 15_000 })
}

// Propose a candidate version on an artifact through the API (commenter+ — an
// editor teammate in tests). Drives the review flow without the editor UI.
export async function proposeEdit(
  req: APIRequestContext,
  shortId: string,
  message: string,
  body: string,
): Promise<void> {
  await expect(async () => {
    const res = await req.post(`/v1/artifacts/${shortId}/proposals`, {
      multipart: {
        file: { name: "edit.md", mimeType: "text/markdown", buffer: Buffer.from(body) },
        message,
      },
    })
    expect(res.ok(), `propose failed: ${res.status()}`).toBeTruthy()
  }).toPass({ timeout: 10_000 })
}

// Grant another account a role on an artifact (the GDocs-style per-artifact share).
// Needed so a collaborator can comment/propose — only members can; an anonymous or
// non-member link visitor is read-only.
export async function shareArtifact(
  req: APIRequestContext,
  shortId: string,
  email: string,
  role: "viewer" | "commenter" | "editor" | "owner",
): Promise<void> {
  await expect(async () => {
    const res = await req.put(`/v1/artifacts/${shortId}/members`, { data: { email, role } })
    expect(res.ok(), `share failed: ${res.status()}`).toBeTruthy()
  }).toPass({ timeout: 10_000 })
}

import { Buffer } from "node:buffer"
import type { APIRequestContext } from "@playwright/test"
import { STORAGE_KEYS } from "../../src/lib/storage-keys"
import { expect, test } from "../fixtures"

// The strong MCP loop, browser side: an agent-credentialed publish auto-opens the
// owner's tab (a created artifact navigates; a revision live-reloads with the review
// card repainting), agent publishes land private (the owner's draft — invisible
// to teammates until the share dialog promotes it) and the per-device toggle
// downgrades auto-open to a notification. The
// agent side is the real token + API — the same calls the MCP server and CLI
// make — so the loop under test is the shipped one, not a mock.

async function createAgent(
  req: APIRequestContext,
  name: string,
): Promise<{ id: string; token: string }> {
  const res = await req.post("/v1/agents", { data: { name, role: "editor" } })
  expect(res.ok(), `create agent failed: ${res.status()}`).toBeTruthy()
  return (await res.json()) as { id: string; token: string }
}

// An agent publish over the /v1 path (what the CLI and stdio shim do): bearer
// auth, optional short_id for a revision, optional review round.
async function agentPublish(
  req: APIRequestContext,
  token: string,
  args: { title?: string; content: string; shortId?: string; requestReview?: boolean },
): Promise<{ short_id: string; visibility: string; opened_in_tab?: boolean }> {
  const multipart: {
    [key: string]: string | { name: string; mimeType: string; buffer: Buffer }
  } = {
    file: { name: "index.html", mimeType: "text/html", buffer: Buffer.from(args.content) },
  }
  if (args.title) multipart.title = args.title
  if (args.requestReview) multipart.request_review = "true"
  const url = args.shortId ? `/v1/artifacts/${args.shortId}/versions` : "/v1/artifacts"
  const res = await req.post(url, {
    headers: { authorization: `Bearer ${token}` },
    multipart,
  })
  expect(res.ok(), `agent publish failed: ${res.status()}`).toBeTruthy()
  return (await res.json()) as { short_id: string; visibility: string; opened_in_tab?: boolean }
}

test.describe("the MCP loop — auto-open, live rounds, private drafts", () => {
  test("a created agent draft auto-opens the tab; a revision live-reloads and repaints the review card", async ({
    owner,
  }) => {
    const agent = await createAgent(owner.request, "Drafter")
    await owner.goto("/")
    // The per-user stream must be live before the push (the bell holds it).
    await expect(owner.getByTestId("notif-bell")).toBeVisible()
    await owner.waitForTimeout(500)

    // Agent creates a draft with a review ask → the parked tab navigates itself.
    const created = await agentPublish(owner.request, agent.token, {
      title: "Loop Draft",
      content: "<h1>Draft v1</h1><p>alpha</p>",
      requestReview: true,
    })
    expect(created.visibility).toBe("private")
    await expect(owner).toHaveURL(new RegExp(`/artifacts/.*${created.short_id}`), {
      timeout: 10_000,
    })
    await expect(owner.frameLocator("iframe").locator("h1")).toHaveText("Draft v1")

    // The round is waiting in the comments rail (the panel defaults open on
    // desktop; the FAB reopens it if this browser had it collapsed).
    const fab = owner.getByTestId("artifact-comments-fab")
    if (await fab.isVisible().catch(() => false)) await fab.click()
    await expect(owner.getByTestId("review-card")).toBeVisible()
    await owner.getByTestId("review-send-back").click()
    await expect(owner.getByTestId("review-card")).toBeHidden()

    // Agent revises with a new round → the page live-reloads in place (same URL)
    // and the card REPAINTS from the review.requested event — the regression this
    // spec pins is the card staying dead until a manual reload.
    await agentPublish(owner.request, agent.token, {
      content: "<h1>Draft v2</h1><p>beta</p>",
      shortId: created.short_id,
      requestReview: true,
    })
    await expect(owner.frameLocator("iframe").locator("h1")).toHaveText("Draft v2", {
      timeout: 10_000,
    })
    await expect(owner).toHaveURL(new RegExp(`/artifacts/.*${created.short_id}`))
    await expect(owner.getByTestId("review-card")).toBeVisible({ timeout: 10_000 })
  })

  test("agent drafts stay the owner's until promoted to Workspace; the toggle quiets auto-open", async ({
    owner,
  }) => {
    const agent = await createAgent(owner.request, "Drafter")
    await owner.goto("/")
    await expect(owner.getByTestId("notif-bell")).toBeVisible()
    // Auto-open off (the Appearance toggle writes the same key) → a created
    // publish must NOT yank navigation; it lands as a notification instead.
    await owner.evaluate((key) => localStorage.setItem(key, "off"), STORAGE_KEYS.autoOpen)
    await owner.waitForTimeout(500)

    const created = await agentPublish(owner.request, agent.token, {
      title: "Hidden Draft",
      content: "<h1>hush</h1>",
    })
    expect(created.visibility).toBe("private")
    await owner.waitForTimeout(1000)
    await expect(owner).toHaveURL(/\/$/) // still home — the toggle held navigation

    // A private draft is the owner's: it shows in THEIR library (private rows
    // list for their members), carries the Private chip, and narrows under
    // Created by me — the agent published on the owner's behalf.
    await owner.reload()
    await expect(owner.getByText("Hidden Draft").first()).toBeVisible()
    await owner.getByTestId("library-tab-mine").click()
    await expect(owner).toHaveURL(/tab=mine/)
    await expect(owner.getByText("Hidden Draft").first()).toBeVisible()

    // Promote: share dialog → Workspace. One gesture, now it lists in All artifacts too.
    await owner.goto(`/artifacts/${created.short_id}`)
    await owner.getByTestId("share-trigger").click()
    await owner.getByTestId("share-visibility").click()
    await owner.getByRole("menuitemradio", { name: "Workspace", exact: true }).click()
    await owner.keyboard.press("Escape")

    await owner.goto("/")
    await expect(owner.getByText("Hidden Draft").first()).toBeVisible({ timeout: 10_000 })
    // Created by me is authorship, not visibility — it keeps finding the doc
    // no matter how widely it's since been shared.
    await owner.getByTestId("library-tab-mine").click()
    await expect(owner.getByText("Hidden Draft").first()).toBeVisible()
  })
})

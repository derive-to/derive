import { Buffer } from "node:buffer"
import type { Page } from "@playwright/test"
import { expect, openArtifact, test } from "../fixtures"

// "Hide live cursors" in the ⋯ menu opts the viewer out of the live layer: peers'
// cursors disappear, and (verified by the menu-item state) yours stops broadcasting.
// Toggling back on repaints peers as their frames arrive. The toggle is a checkbox
// item, so its on/off state rides aria-checked.

async function publishPublic(page: Page): Promise<string> {
  let shortId = ""
  await expect(async () => {
    const res = await page.request.post("/v1/artifacts", {
      multipart: {
        file: { name: "hide.md", mimeType: "text/markdown", buffer: Buffer.from("# Hide\n\nbody") },
        link_role: "viewer",
      },
    })
    expect(res.ok(), `publish failed: ${res.status()}`).toBeTruthy()
    shortId = ((await res.json()) as { short_id: string }).short_id
  }).toPass({ timeout: 10_000 })
  return shortId
}

test("hide cursors: peers disappear, then return when toggled back on", async ({
  owner,
  secondUser,
}) => {
  const shortId = await publishPublic(owner)
  await openArtifact(owner, shortId)
  const peer = (body: Record<string, unknown> = {}) =>
    secondUser.page.request.post(`/v1/artifacts/${shortId}/cursor`, {
      data: { id: "peer-hide", x: 0.5, y: 0.4, ...body },
    })

  // A peer cursor is visible first (retry until the owner's SSE has connected).
  await expect(async () => {
    expect((await peer()).ok()).toBeTruthy()
    await expect(owner.getByTestId("remote-cursor")).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 15_000 })

  // Hide live cursors (from the ⋯ menu) → the peer is dropped immediately. The menu
  // stays open on toggle so the checked state is observable.
  await owner.getByTestId("artifact-more").click()
  await owner.getByTestId("cursor-hide").click()
  await expect(owner.getByTestId("cursor-hide")).toHaveAttribute("aria-checked", "true")
  await expect(owner.getByTestId("remote-cursor")).toHaveCount(0)

  // Still hidden: a fresh peer frame is ignored, not painted.
  await peer()
  await owner.waitForTimeout(300)
  await expect(owner.getByTestId("remote-cursor")).toHaveCount(0)

  // Toggle back on → peers paint again.
  await owner.getByTestId("cursor-hide").click()
  await expect(owner.getByTestId("cursor-hide")).toHaveAttribute("aria-checked", "false")
  await owner.keyboard.press("Escape") // close the menu so it doesn't overlay the layer
  await expect(async () => {
    expect((await peer()).ok()).toBeTruthy()
    await expect(owner.getByTestId("remote-cursor")).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 15_000 })
})

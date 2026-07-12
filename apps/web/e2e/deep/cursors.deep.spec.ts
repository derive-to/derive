import { Buffer } from "node:buffer"
import type { Page } from "@playwright/test"
import { expect, openArtifact, test } from "../fixtures"

// Live multiplayer cursors, end to end across two real browser contexts: a peer's
// cursor reaches the other viewer over SSE, carries a chosen look, and is removed
// the instant the peer signals it left — no 8s lingering. Plus the self picker.

async function publishPublic(page: Page): Promise<string> {
  let shortId = ""
  await expect(async () => {
    const res = await page.request.post("/v1/artifacts", {
      multipart: {
        file: { name: "live.md", mimeType: "text/markdown", buffer: Buffer.from("# Live\n\nbody") },
        link_role: "viewer",
      },
    })
    expect(res.ok(), `publish failed: ${res.status()}`).toBeTruthy()
    shortId = ((await res.json()) as { short_id: string }).short_id
  }).toPass({ timeout: 10_000 })
  return shortId
}

test.describe("live multiplayer cursors", () => {
  test("a peer cursor appears, restyles to an emoji, and leaves on signal", async ({
    owner,
    secondUser,
  }) => {
    const shortId = await publishPublic(owner)
    await openArtifact(owner, shortId)

    // The second viewer drives a cursor through the real API (a different session,
    // so the name is server-derived). The owner's page should paint it.
    const peer = (body: Record<string, unknown>) =>
      secondUser.page.request.post(`/v1/artifacts/${shortId}/cursor`, {
        data: { id: "peer-1", x: 0.5, y: 0.4, ...body },
      })

    // Appears — retry the publish until the owner's SSE has connected and painted.
    await expect(async () => {
      expect((await peer({ color: "#7c6cbd", kind: "arrow" })).ok()).toBeTruthy()
      await expect(owner.getByTestId("remote-cursor")).toBeVisible({ timeout: 1000 })
    }).toPass({ timeout: 15_000 })
    // Identity is server-derived, never a client field.
    await expect(owner.getByTestId("remote-cursor")).toContainText("Second User")

    // Restyle to an emoji cursor — the glyph swaps.
    await peer({ kind: "emoji", emoji: "🦊" })
    await expect(owner.getByTestId("remote-cursor")).toContainText("🦊")

    // Leave → removed promptly.
    await peer({ gone: true })
    await expect(owner.getByTestId("remote-cursor")).toHaveCount(0)
  })

  test("follow a peer from the facepile shows a banner and Stop releases it", async ({
    owner,
    secondUser,
  }) => {
    const shortId = await publishPublic(owner)
    await openArtifact(owner, shortId)
    // The second viewer opens the SAME doc, so they land in the presence facepile — and
    // because the cursor id is now the presence id, following them from the facepile lines
    // up with their cursor. The facepile only renders once a peer is present.
    await openArtifact(secondUser.page, shortId)

    await expect(owner.getByTestId("presence-trigger")).toBeVisible({ timeout: 15_000 })
    await owner.getByTestId("presence-trigger").click()
    await owner.getByTestId("presence-follow").click()

    // The banner names who we're locked to; Stop releases us.
    await expect(owner.getByTestId("follow-banner")).toContainText("Second User")
    await owner.getByTestId("follow-stop").click()
    await expect(owner.getByTestId("follow-banner")).toHaveCount(0)
  })

  test("you can customize your own cursor", async ({ owner }) => {
    const shortId = await publishPublic(owner)
    await openArtifact(owner, shortId)

    await owner.getByTestId("cursor-self-trigger").click()
    await owner.getByTestId("cursor-kind-emoji").click()
    await owner.getByTestId("cursor-emoji-2").click() // 🦊
    await expect(owner.getByTestId("cursor-self-trigger")).toContainText("🦊")
  })
})

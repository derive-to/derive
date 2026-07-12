import { Buffer } from "node:buffer"
import type { Page } from "@playwright/test"
import { expect, openArtifact, test } from "../fixtures"

// Live multiplayer cursors, end to end across two real browser contexts: a peer's
// cursor reaches the other viewer over SSE tagged with its SERVER-derived identity
// (name → tint, never a client field), and is removed the instant the peer signals it
// left — no 8s lingering. There's no look to pick: a cursor is an identity-tinted arrow.

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
  test("a peer cursor appears with its server-derived identity, and leaves on signal", async ({
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
      expect((await peer({})).ok()).toBeTruthy()
      await expect(owner.getByTestId("remote-cursor")).toBeVisible({ timeout: 1000 })
    }).toPass({ timeout: 15_000 })
    // Identity is server-derived, never a client field — the name tags the cursor and
    // (on the paint side) tints it. No emoji, no client-chosen color.
    await expect(owner.getByTestId("remote-cursor")).toContainText("Second User")

    // Leave → removed promptly.
    await peer({ gone: true })
    await expect(owner.getByTestId("remote-cursor")).toHaveCount(0)
  })
})

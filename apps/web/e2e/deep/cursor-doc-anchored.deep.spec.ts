import { Buffer } from "node:buffer"
import type { Page } from "@playwright/test"
import { expect, openArtifact, test } from "../fixtures"

// Cursors are anchored to a position in the DOCUMENT, not the viewport. A peer
// whose document position is below the fold (the viewer is at the top of a tall
// doc) shows as a bottom edge indicator, not a cursor pinned to the screen; when
// their position is on-screen, a real cursor is painted and the indicator clears.

const tall = `# Tall document\n\n${Array.from(
  { length: 120 },
  (_, i) => `Paragraph ${i + 1}. Lorem ipsum dolor sit amet, consectetur adipiscing elit.`,
).join("\n\n")}`

async function publishTall(page: Page): Promise<string> {
  let shortId = ""
  await expect(async () => {
    const res = await page.request.post("/v1/artifacts", {
      multipart: {
        file: { name: "tall.md", mimeType: "text/markdown", buffer: Buffer.from(tall) },
        visibility: "public",
      },
    })
    expect(res.ok(), `publish failed: ${res.status()}`).toBeTruthy()
    shortId = ((await res.json()) as { short_id: string }).short_id
  }).toPass({ timeout: 10_000 })
  return shortId
}

test("a peer below the fold is a bottom edge indicator, then a cursor when on-screen", async ({
  owner,
  secondUser,
}) => {
  const shortId = await publishTall(owner)
  await openArtifact(owner, shortId)
  const peer = (y: number) =>
    secondUser.page.request.post(`/v1/artifacts/${shortId}/cursor`, {
      data: { id: "peer-doc", x: 0.5, y, color: "#7c6cbd", kind: "arrow" },
    })

  // Near the bottom of the doc while the owner sits at the top → below the fold,
  // so a bottom edge indicator appears (retry until SSE + geometry have settled).
  await expect(async () => {
    expect((await peer(0.96)).ok()).toBeTruthy()
    await expect(owner.getByTestId("cursor-offscreen-bottom")).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 20_000 })

  // Move to the very top → on-screen: the indicator clears and a cursor is painted.
  await expect(async () => {
    expect((await peer(0.01)).ok()).toBeTruthy()
    await expect(owner.getByTestId("cursor-offscreen-bottom")).toHaveCount(0)
    await expect(owner.getByTestId("remote-cursor")).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 20_000 })
})

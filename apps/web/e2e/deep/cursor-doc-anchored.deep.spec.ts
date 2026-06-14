import { Buffer } from "node:buffer"
import type { Page } from "@playwright/test"
import { expect, openArtifact, test } from "../fixtures"

// Cursors are anchored to a position in the DOCUMENT, not the viewport. A peer
// whose document position is outside the viewer's scroll window shows as a top /
// bottom edge indicator (Miro/Figma style), not a cursor pinned to the screen;
// scrolling moves peers with the content, and an on-screen peer is a real cursor.

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

// Drive a peer cursor at a document-normalized y from a second viewer.
const peerOf =
  (page: Page, shortId: string, id: string) =>
  (y: number, x = 0.5) =>
    page.request.post(`/v1/artifacts/${shortId}/cursor`, {
      data: { id, x, y, color: "#7c6cbd", kind: "arrow" },
    })

test("a peer below the fold is a bottom indicator (with a count), then a cursor on-screen", async ({
  owner,
  secondUser,
}) => {
  const shortId = await publishTall(owner)
  await openArtifact(owner, shortId)
  const peer = peerOf(secondUser.page, shortId, "peer-doc")

  // Near the bottom of the doc while the owner sits at the top → below the fold,
  // so a bottom edge indicator appears, counting one peer.
  await expect(async () => {
    expect((await peer(0.96)).ok()).toBeTruthy()
    await expect(owner.getByTestId("cursor-offscreen-bottom")).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 20_000 })
  await expect(owner.getByTestId("cursor-offscreen-bottom")).toContainText("1")

  // Move to the very top → on-screen: the indicator clears and a cursor is painted.
  await expect(async () => {
    expect((await peer(0.01)).ok()).toBeTruthy()
    await expect(owner.getByTestId("cursor-offscreen-bottom")).toHaveCount(0)
    await expect(owner.getByTestId("remote-cursor")).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 20_000 })
})

test("scrolling moves peers with the document: a top peer passes above the fold", async ({
  owner,
  secondUser,
}) => {
  const shortId = await publishTall(owner)
  await openArtifact(owner, shortId)
  const top = peerOf(secondUser.page, shortId, "peer-top")
  const bottom = peerOf(secondUser.page, shortId, "peer-bottom")

  // A peer near the very top (on-screen) and one well below the fold: a bottom
  // indicator only, nobody above yet.
  await expect(async () => {
    expect((await top(0.02)).ok()).toBeTruthy()
    expect((await bottom(0.6)).ok()).toBeTruthy()
    await expect(owner.getByTestId("cursor-offscreen-bottom")).toBeVisible({ timeout: 1000 })
    await expect(owner.getByTestId("cursor-offscreen-top")).toHaveCount(0)
  }).toPass({ timeout: 20_000 })

  // Click the bottom indicator to scroll down; the top peer is glued to the
  // document, so it passes above the fold and becomes a TOP indicator.
  await expect(async () => {
    await owner
      .getByTestId("cursor-offscreen-bottom")
      .click()
      .catch(() => {})
    expect((await top(0.02)).ok()).toBeTruthy()
    expect((await bottom(0.6)).ok()).toBeTruthy()
    await expect(owner.getByTestId("cursor-offscreen-top")).toBeVisible({ timeout: 1500 })
  }).toPass({ timeout: 25_000 })
})

test("hiding cursors removes the edge indicators too", async ({ owner, secondUser }) => {
  const shortId = await publishTall(owner)
  await openArtifact(owner, shortId)
  const peer = peerOf(secondUser.page, shortId, "peer-doc")

  await expect(async () => {
    expect((await peer(0.92)).ok()).toBeTruthy()
    await expect(owner.getByTestId("cursor-offscreen-bottom")).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 20_000 })

  // Opt out of the layer entirely → no cursors and no edge indicators.
  await owner.getByTestId("cursor-self-trigger").click()
  await owner.getByTestId("cursor-hide").click()
  await expect(owner.getByTestId("cursor-offscreen-bottom")).toHaveCount(0)
  await expect(owner.getByTestId("remote-cursor")).toHaveCount(0)
})

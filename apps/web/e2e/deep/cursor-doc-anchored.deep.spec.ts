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
        link_role: "viewer",
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

test("capture side: the iframe reports a document position, so the same screen point yields a different y after scrolling", async ({
  owner,
}) => {
  const shortId = await publishTall(owner)
  await openArtifact(owner, shortId)

  // Record the y of every cursor frame the app posts for our own pointer.
  const ys: number[] = []
  owner.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/cursor")) {
      try {
        const b = req.postDataJSON() as { y?: number }
        if (typeof b?.y === "number") ys.push(b.y)
      } catch {
        /* non-JSON body */
      }
    }
  })

  const box = await owner.locator("iframe").first().boundingBox()
  if (!box) throw new Error("no iframe box")
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2

  // Move at a fixed point over the artifact → a frame at scroll 0.
  await owner.mouse.move(cx - 4, cy - 4)
  await owner.mouse.move(cx, cy)
  await expect.poll(() => ys.length, { timeout: 10_000 }).toBeGreaterThan(0)
  const atTop = ys.at(-1) as number

  // Scroll the document, then move to the SAME screen point again.
  await owner.mouse.move(cx, cy)
  await owner.mouse.wheel(0, 2000)
  await owner.waitForTimeout(400)
  ys.length = 0
  await owner.mouse.move(cx + 4, cy + 4)
  await owner.mouse.move(cx, cy)
  await expect.poll(() => ys.length, { timeout: 10_000 }).toBeGreaterThan(0)
  const afterScroll = ys.at(-1) as number

  // Same screen position, but scrolled down → a larger fraction of the document.
  // (A viewport-relative cursor would report the same y both times.)
  expect(afterScroll).toBeGreaterThan(atTop + 0.02)
})

test("stress: many peers and rapid scrolling stay consistent (above + below at once)", async ({
  owner,
  secondUser,
}) => {
  const shortId = await publishTall(owner)
  await openArtifact(owner, shortId)
  const N = 12
  // A crowd spread evenly down the document, re-sent in parallel to keep alive.
  const sendAll = () =>
    Promise.all(
      Array.from({ length: N }, (_, i) =>
        secondUser.page.request.post(`/v1/artifacts/${shortId}/cursor`, {
          data: { id: `s${i}`, x: ((i % 5) + 1) / 6, y: (i + 1) / (N + 1), color: "#7c6cbd" },
        }),
      ),
    )

  await expect(async () => {
    await sendAll()
    await expect(owner.getByTestId("cursor-offscreen-bottom")).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 20_000 })

  // Rapidly scroll into the middle; peers stay alive and re-map every frame.
  for (let i = 0; i < 6; i++) {
    await owner
      .getByTestId("cursor-offscreen-bottom")
      .click()
      .catch(() => {})
    await sendAll()
    await owner.waitForTimeout(120)
  }

  // In the middle of a tall doc the crowd splits: some above, some below — and the
  // page is still alive and rendering cursors (no crash under load).
  await expect(async () => {
    await sendAll()
    await expect(owner.getByTestId("cursor-offscreen-top")).toBeVisible({ timeout: 1500 })
    await expect(owner.getByTestId("cursor-offscreen-bottom")).toBeVisible({ timeout: 1500 })
  }).toPass({ timeout: 20_000 })
})

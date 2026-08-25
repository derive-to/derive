import { Buffer } from "node:buffer"
import { DECK_TEMPLATE, pageTextParts } from "@derive/core"
import type { Page } from "@playwright/test"
import { expect, openArtifact, publishArtifact, test } from "../fixtures"

const frame = (page: Page) => page.frameLocator("iframe[title]")

const contentOf = async (page: Page, shortId: string): Promise<string> => {
  const response = await page.request.get(`/v1/artifacts/${shortId}/content`)
  expect(response.ok(), `content fetch failed: ${response.status()}`).toBeTruthy()
  return response.text()
}

const versionOf = async (page: Page, shortId: string): Promise<number> => {
  const response = await page.request.get(`/v1/artifacts/${shortId}`)
  expect(response.ok(), `artifact fetch failed: ${response.status()}`).toBeTruthy()
  return ((await response.json()) as { current_version: number }).current_version
}

const enterEditMode = async (page: Page) => {
  await page.getByTestId("artifact-inline-edit").click()
  await expect(page.getByTestId("inline-edit-bar")).toBeVisible()
}

test("[BROWSER-MD-001] Markdown multi-run selection stores valid source", async ({ owner }) => {
  const source =
    "# Chief of Staff\n\n" +
    "**San Francisco · Full-time · In person**  \n" +
    "**$150,000–$180,000 base + discretionary bonus + carry eligibility**\n\n" +
    "## The opportunity\n"
  const shortId = await publishArtifact(owner, "role.md", source, "text/markdown")
  await openArtifact(owner, shortId)
  await enterEditMode(owner)

  const subtitle = frame(owner).locator("p").first()
  await subtitle.click()
  await subtitle.evaluate((element) => {
    const runs = element.querySelectorAll("strong")
    const first = runs[0]?.firstChild
    const second = runs[1]?.firstChild
    if (!first || !second) throw new Error("subtitle runs missing")
    const range = document.createRange()
    range.setStart(first, first.textContent?.lastIndexOf("person") ?? 0)
    range.setEnd(second, second.textContent?.length ?? 0)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await owner.keyboard.type("person")
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("1 unsaved change")
  await owner.getByTestId("inline-edit-save").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()

  const stored = await contentOf(owner, shortId)
  expect(stored).toBe(
    "# Chief of Staff\n\n**San Francisco · Full-time · In person**\n\n## The opportunity\n",
  )
})

test("[BROWSER-MD-002] a rendered GFM list selection maps back through emphasis", async ({
  owner,
}) => {
  const source = "# GFM\n\n- raw **list**\n- [x] task **done**\n"
  const shortId = await publishArtifact(owner, "gfm.md", source, "text/markdown")
  await openArtifact(owner, shortId)
  await enterEditMode(owner)

  const item = frame(owner).getByRole("listitem").first()
  await item.click()
  await item.evaluate((element) => {
    const first = element.firstChild
    const last = element.querySelector("strong")?.firstChild
    if (!first || !last) throw new Error("rendered GFM runs missing")
    const range = document.createRange()
    range.setStart(first, first.textContent?.indexOf("raw") ?? 0)
    range.setEnd(last, last.textContent?.length ?? 0)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await owner.keyboard.type("raw item")
  await owner.getByTestId("inline-edit-save").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()

  expect(await contentOf(owner, shortId)).toBe("# GFM\n\n- raw **item**\n- [x] task **done**\n")
  await expect(frame(owner).getByRole("listitem").first()).toHaveText("raw item")
  await expect(frame(owner).getByRole("listitem").nth(1)).toContainText("task done")
})

test("[BROWSER-HTML-001] formatting, resize, undo/redo, and authored bytes survive one save", async ({
  owner,
}) => {
  const source = `<h1>Editing matrix</h1>
<p id="plain"><mark data-note="keep">Authored</mark> and format target beside <a href="https://derive.to?x=1&amp;y=2">this link</a>.</p>
<img id="hero" alt="Hero" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='90'%3E%3C/svg%3E" style="display:block;width:160px;height:90px">`
  const shortId = await publishArtifact(owner, "matrix.html", source, "text/html")
  await openArtifact(owner, shortId)
  await enterEditMode(owner)

  const paragraph = frame(owner).locator("#plain")
  await paragraph.click()
  await paragraph.evaluate((element) => {
    const text = [...element.childNodes].find(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes("target"),
    )
    if (!text) throw new Error("plain target text missing")
    const start = text.textContent?.indexOf("target") ?? -1
    if (start < 0) throw new Error("selection text missing")
    const range = document.createRange()
    range.setStart(text, start)
    range.setEnd(text, start + 6)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event("selectionchange"))
  })
  await expect(owner.getByTestId("inline-edit-bold")).toBeEnabled()
  await owner.getByTestId("inline-edit-bold").click()
  await expect(owner.getByTestId("inline-edit-undo")).toBeEnabled()
  await owner.getByTestId("inline-edit-undo").click()
  await owner.getByTestId("inline-edit-redo").click()

  const image = frame(owner).locator("#hero")
  await image.hover()
  const size = frame(owner).getByRole("button", { name: "Set element size" })
  await size.click()
  const sizeForm = frame(owner).getByRole("form", { name: "Element size" })
  await sizeForm.getByLabel("Width in pixels").fill("200")
  await sizeForm.getByRole("button", { name: "Apply" }).click()
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("2 unsaved changes")

  await owner.getByTestId("inline-edit-save").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()
  const stored = await contentOf(owner, shortId)
  expect(stored).toContain(
    '<p id="plain"><mark data-note="keep">Authored</mark> and format <b>target</b> beside <a href="https://derive.to?x=1&amp;y=2">this link</a>.</p>',
  )
  expect(stored).toContain("display:block; width: 200px; height: auto")
  expect(stored).not.toContain("data-derive-fmt")
})

test("[BROWSER-DECK-001] a slide edit preserves deck position behavior and identities", async ({
  owner,
}) => {
  const shortId = await publishArtifact(owner, "deck.html", DECK_TEMPLATE, "text/html")
  await openArtifact(owner, shortId)
  await expect(owner.getByTestId("deck-position")).toHaveText("1 / 3")
  await owner.getByTestId("deck-next").click()
  await expect(owner.getByTestId("deck-position")).toHaveText("2 / 3")
  await enterEditMode(owner)

  const title = frame(owner).getByRole("heading", {
    name: "The stage is fixed. Only the scale changes.",
  })
  await title.click({ force: true })
  await owner.keyboard.press("End")
  await owner.keyboard.type(" Updated.")
  await expect(owner.getByTestId("deck-position")).toHaveText("2 / 3")
  await owner.getByTestId("inline-edit-save").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()

  const stored = await contentOf(owner, shortId)
  expect(stored).toContain("The stage is fixed. Only the scale changes. Updated.")
  expect([...stored.matchAll(/data-derive-slide="(\d+)"/g)].map((match) => match[1])).toEqual([
    "0",
    "1",
    "2",
  ])
  await expect(owner.getByTestId("deck-position")).toHaveText("2 / 3")
  await expect(
    frame(owner).getByText("The stage is fixed. Only the scale changes. Updated."),
  ).toBeVisible()
  await owner.getByTestId("deck-prev").click()
  await expect(owner.getByTestId("deck-position")).toHaveText("1 / 3")
  await owner.getByTestId("deck-next").click()
  await expect(owner.getByTestId("deck-position")).toHaveText("2 / 3")
})

test("[BROWSER-DECK-OPS-001] the real versions route preserves identity and rejects no-ops", async ({
  owner,
}) => {
  const source =
    '<section class="slide" data-derive-slide="10">A</section>\n' +
    '<section class="slide" data-derive-slide="11">B</section><script>"derive-deck"</script>'
  const shortId = await publishArtifact(owner, "ops.html", source, "text/html")
  const duplicate = await owner.request.post(`/v1/artifacts/${shortId}/versions`, {
    multipart: {
      slide_ops: JSON.stringify([{ op: "duplicate", at: 1 }]),
      base_version: "1",
      message: "Duplicate the opening slide",
    },
  })
  expect(duplicate.status()).toBe(201)
  const stored = await contentOf(owner, shortId)
  expect([...stored.matchAll(/data-derive-slide="(\d+)"/g)].map((match) => match[1])).toEqual([
    "10",
    "12",
    "11",
  ])
  expect(pageTextParts(stored).text.replace(/\s+/g, "")).toContain("AAB")
  expect(await versionOf(owner, shortId)).toBe(2)

  const noOp = await owner.request.post(`/v1/artifacts/${shortId}/versions`, {
    multipart: {
      slide_ops: JSON.stringify([{ op: "move", from: 2, to: 2 }]),
      base_version: "2",
    },
  })
  expect(noOp.status()).toBe(400)
  expect(await versionOf(owner, shortId)).toBe(2)
  expect(await contentOf(owner, shortId)).toBe(stored)
})

test("[BROWSER-CONCURRENCY-001] stale save keeps dirty work and succeeds after re-read", async ({
  owner,
}) => {
  const v1 = '<h1>Concurrent</h1><p id="mine">My paragraph.</p><p>Original external line.</p>'
  const v2 = '<h1>Concurrent</h1><p id="mine">My paragraph.</p><p>Changed externally.</p>'
  const shortId = await publishArtifact(owner, "concurrent.html", v1, "text/html")
  await openArtifact(owner, shortId)
  await enterEditMode(owner)
  await frame(owner).locator("#mine").click()
  await owner.keyboard.press("End")
  await owner.keyboard.type(" Pending edit.")

  // Freeze the browser's v1-based save after it has been constructed, then land a
  // full v2 publish through APIRequestContext (which is not intercepted by page.route).
  // This deterministically creates the real race instead of hoping two requests cross.
  let captured!: () => void
  let release!: () => void
  const saveCaptured = new Promise<void>((resolve) => {
    captured = resolve
  })
  const releaseSave = new Promise<void>((resolve) => {
    release = resolve
  })
  let delayed = false
  await owner.route(`**/v1/artifacts/${shortId}/versions`, async (route) => {
    if (!delayed && route.request().method() === "POST") {
      delayed = true
      captured()
      await releaseSave
    }
    await route.continue()
  })

  await owner.getByTestId("inline-edit-save").click()
  await saveCaptured
  const external = await owner.request.post(`/v1/artifacts/${shortId}/versions`, {
    multipart: {
      file: { name: "concurrent.html", mimeType: "text/html", buffer: Buffer.from(v2) },
      message: "Concurrent external publish",
    },
  })
  expect(external.ok(), `external publish failed: ${external.status()}`).toBeTruthy()
  expect(await versionOf(owner, shortId)).toBe(2)
  release()

  await expect(
    owner.getByText("The artifact changed while you were editing.", { exact: true }),
  ).toBeVisible()
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("1 unsaved change")
  await expect(frame(owner).locator("#mine")).toHaveText("My paragraph. Pending edit.")
  expect(await versionOf(owner, shortId)).toBe(2)

  await owner.getByTestId("inline-edit-save").click()
  await expect(owner.getByTestId("inline-edit-bar")).toBeHidden()
  // The retry is another attended inline save by the same user, so the current
  // unreviewed web version is intentionally coalesced instead of appending v3.
  expect(await versionOf(owner, shortId)).toBe(2)
  const stored = await contentOf(owner, shortId)
  expect(stored).toContain("My paragraph. Pending edit.")
  expect(stored).toContain("Changed externally.")
})

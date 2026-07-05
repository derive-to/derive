import { Buffer } from "node:buffer"
import type { Page } from "@playwright/test"
import { expect, openArtifact, test } from "../fixtures"

// A comment whose quote spans MULTIPLE elements (a heading + a paragraph). The old
// capture took `exact` from Selection.toString() — whose block-boundary newlines don't
// match the DOM text-node concatenation the resolver greps — so a multi-element comment
// stored a mismatched quote and orphaned as "text changed", never highlighting. The fix:
// capture the quote from the same text-node concatenation, and resolve WHITESPACE-
// FLEXIBLY. This drives the real selection→comment path and asserts the highlight paints.

// Realistic markup: a heading and a paragraph on separate, indented lines (so the source
// whitespace between the blocks is "\n      ", the case that broke the old strict match).
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Doc</title></head>
<body style="font:18px/1.7 system-ui;padding:40px;max-width:640px">
      <h1 id="h">Hello, Derive 👋</h1>
      <p id="p">A self-contained test artifact. Scripts run in a sandbox.</p>
</body></html>`

async function publishHtml(page: Page): Promise<string> {
  let shortId = ""
  await expect(async () => {
    const res = await page.request.post("/v1/artifacts", {
      multipart: { file: { name: "doc.html", mimeType: "text/html", buffer: Buffer.from(html) } },
    })
    expect(res.ok(), `publish failed: ${res.status()}`).toBeTruthy()
    shortId = ((await res.json()) as { short_id: string }).short_id
  }).toPass({ timeout: 10_000 })
  return shortId
}

// How many ranges the base text-highlight is painting (the CSS Custom Highlight API).
async function highlightCount(page: Page): Promise<number> {
  const frame = page.frames().find((f) => f.url().includes("/raw/"))
  if (!frame) throw new Error("render frame not found")
  return frame.evaluate(() => {
    const reg = (globalThis as unknown as { CSS?: { highlights?: Map<string, { size: number }> } })
      .CSS?.highlights
    return reg?.get("derive-hl")?.size ?? -1
  })
}

test("a comment spanning a heading and a paragraph resolves and highlights", async ({
  owner: page,
}) => {
  const shortId = await publishHtml(page)
  await openArtifact(page, shortId)
  await expect(page.frameLocator("iframe").getByText(/self-contained/)).toBeVisible()

  // Select from inside the <h1> ("Derive 👋") across into the <p> ("A self-contained
  // test") — a genuine multi-element selection — and fire mouseup (the capture path).
  const frame = page.frames().find((f) => f.url().includes("/raw/"))
  if (!frame) throw new Error("render frame not found")
  await frame.evaluate(() => {
    const h = document.querySelector("h1")?.firstChild
    const p = document.querySelector("p")?.firstChild
    if (!h || !p) throw new Error("missing nodes")
    const range = document.createRange()
    range.setStart(h, 7) // "Hello, " → start at "Derive"
    range.setEnd(p, 21) // end after "A self-contained test"
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
  })

  // The desktop selection pill offers "Comment"; post an anchored comment.
  await page.getByTestId("comment-on-selection").click()
  await page.getByTestId("composer-input").fill("This spans two elements.")
  await page.getByTestId("composer-submit").click()

  // The multi-element anchor RESOLVES: the Custom Highlight API paints its range in the
  // document (base=1), and the card is NOT orphaned as "text changed".
  await expect.poll(() => highlightCount(page), { timeout: 8000 }).toBe(1)
  await expect(page.getByText("text changed")).toHaveCount(0)
  await expect(page.getByTestId("comment-card")).toHaveCount(1)
})

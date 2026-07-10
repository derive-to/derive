import { Buffer } from "node:buffer"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, openArtifact, test } from "../fixtures"

// Visual-QA capture for the COMMENTS panel (the dashboard harness's sibling):
// seeds a doc with pinned threads, replies, reactions, a resolved thread and a
// general note, then captures the resting panel, an active thread, the anchored
// composer mid-mention, and dark mode. Not a test gate: self-skips unless
// SHOTS=1, so a bare `playwright test` ignores it.
//   SHOTS=1 SHOT_DIR=/tmp/shots npx playwright test --project=screens
test.skip(() => process.env.SHOTS !== "1", "visual capture harness — set SHOTS=1 to run")

const OUT = process.env.SHOT_DIR ?? join(process.cwd(), "test-results", "screens")
mkdirSync(OUT, { recursive: true })

const PARAS = Array.from(
  { length: 24 },
  (_, i) => `<p id="p${i}">Paragraph ${i}: the quick brown fox ${i} jumps over the lazy dog.</p>`,
).join("\n")
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Doc</title></head>
<body style="font:17px/1.7 system-ui;padding:40px;max-width:620px">
<h1>A living document</h1>${PARAS}</body></html>`

test("capture comment panel states", async ({ owner: page }) => {
  let shortId = ""
  await expect(async () => {
    const res = await page.request.post("/v1/artifacts", {
      multipart: { file: { name: "doc.html", mimeType: "text/html", buffer: Buffer.from(html) } },
    })
    expect(res.ok()).toBeTruthy()
    shortId = ((await res.json()) as { short_id: string }).short_id
  }).toPass({ timeout: 10_000 })

  const comment = async (body: string, exact?: string, thread?: string) => {
    const res = await page.request.post(`/v1/artifacts/${shortId}/comments`, {
      data: {
        body_md: body,
        thread_id: thread,
        anchor: exact ? { type: "TextQuoteSelector", exact } : undefined,
      },
    })
    expect(res.ok()).toBeTruthy()
    return (await res.json()) as { id: string; thread_id: string }
  }
  const a = await comment(
    "This intro reads a bit long — could we tighten it to two sentences?",
    "Paragraph 1: the quick brown fox",
  )
  await comment("Agreed, and let's lead with the number.", undefined, a.thread_id)
  await comment("Nice chart placement here 👍", "Paragraph 3: the quick brown fox")
  const resolved = await comment("Fixed the typo.", "Paragraph 5: the quick brown fox")
  await page.request.post(`/v1/artifacts/${shortId}/comments/${resolved.id}/resolve`, {
    data: { state: "resolved" },
  })
  await comment("General note: publish after the Friday review.")
  await page.request.post(`/v1/artifacts/${shortId}/comments/${a.id}/react`, {
    data: { emoji: "👍" },
  })

  await openArtifact(page, shortId)
  await page.waitForTimeout(1200)

  const shoot = async (name: string) => {
    await page.screenshot({ path: `${OUT}/${name}.png` })
  }
  await shoot("panel-light")

  // Activate the first thread (expanded card with replies + reply box).
  await page.getByText("This intro reads a bit long").first().click()
  await expect(page.getByTestId("comment-resolve")).toBeVisible()
  await page.waitForTimeout(400)
  await shoot("active-light")

  // Dark theme: the real theme store, then reload so the provider applies it.
  await page.evaluate(() => localStorage.setItem("derive_theme", "dark"))
  await page.reload()
  await expect(page.getByText("Comments", { exact: true })).toBeVisible()
  await page.waitForTimeout(1200)
  await page.getByText("This intro reads a bit long").first().click()
  await expect(page.getByTestId("comment-resolve")).toBeVisible()
  await page.waitForTimeout(400)
  await shoot("active-dark")
  await page.keyboard.press("Escape")

  // Composer open on a selection (light again).
  await page.evaluate(() => localStorage.setItem("derive_theme", "light"))
  await page.reload()
  await expect(page.getByText("Comments", { exact: true })).toBeVisible()
  await page.waitForTimeout(1200)
  const frame = page.frames().find((f) => f.url().includes("/raw/"))
  if (!frame) throw new Error("no frame")
  await frame.evaluate(() => {
    const p = document.getElementById("p7")
    if (!p?.firstChild) throw new Error("no p7")
    const r = document.createRange()
    r.setStart(p.firstChild, 0)
    r.setEnd(p.firstChild, 24)
    const s = window.getSelection()
    s?.removeAllRanges()
    s?.addRange(r)
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
  })
  await page.getByTestId("comment-on-selection").click()
  await expect(page.getByTestId("composer-input")).toBeVisible()
  await page.getByTestId("composer-input").pressSequentially("What if we framed this as @")
  await page.waitForTimeout(600)
  await shoot("composer-mention-light")
})

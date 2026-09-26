import { Buffer } from "node:buffer"
import { fileURLToPath } from "node:url"
import {
  applySourceOps,
  DECK_TEMPLATE,
  pageTextParts,
  sliceScenes,
  sourceMap,
  stampSourceIds,
} from "@derive/core"
import type { Page } from "@playwright/test"
import { buildSync } from "esbuild"
import { expect, openArtifact, publishArtifact, test } from "../fixtures"

/** Save, and wait for the server to take it. */
const saveEdits = async (page: Page) => {
  const response = page.waitForResponse(
    (r) => r.url().includes("/versions") && r.request().method() === "POST",
  )
  await page.getByTestId("inline-edit-save").click()
  expect((await response).ok()).toBe(true)
}
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
  await saveEdits(owner)

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
  await saveEdits(owner)

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

  await saveEdits(owner)
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
  // The canonical deck marks its headings as structural nodes: one click selects the
  // box (move/resize), a double click reaches the words. Keys pressed while only the
  // box is selected still belong to the deck, so End would jump to the last slide.
  await title.dblclick({ force: true })
  await owner.keyboard.press("End")
  await owner.keyboard.type(" Updated.")
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("1 unsaved change")
  await expect(owner.getByTestId("deck-position")).toHaveText("2 / 3")
  await saveEdits(owner)

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

test("[BROWSER-VIDEO-001] moving a scene keeps that stable scene active", async ({ owner }) => {
  const source =
    '<main data-derive-video><section data-derive-scene="a" data-duration-ms="5000"><h2>A</h2></section>' +
    '<section data-derive-scene="b" data-duration-ms="5000"><h2>B</h2></section>' +
    '<section data-derive-scene="c" data-duration-ms="5000"><h2>C</h2></section></main>'
  const shortId = await publishArtifact(owner, "active-scene.html", source, "text/html")
  await openArtifact(owner, shortId)
  await expect(owner.getByTestId("video-bar")).toBeVisible()
  await owner.getByTestId("video-next").click()
  await expect(frame(owner).locator("[data-derive-video-active]")).toHaveText("B")

  await enterEditMode(owner)
  await expect(owner.getByTestId("artifact-inspect-scene")).toContainText("Scene 2 of 3")
  await owner.getByTestId("artifact-inspect-scene-earlier").click()
  await expect(frame(owner).locator("[data-derive-video-active]")).toHaveText("B")
  await expect(owner.getByTestId("artifact-inspect-scene")).toContainText("Scene 1 of 3")

  await saveEdits(owner)
  const stored = await contentOf(owner, shortId)
  expect(
    sliceScenes(stored).map((scene) =>
      pageTextParts(stored.slice(scene.start, scene.end)).text.trim(),
    ),
  ).toEqual(["B", "A", "C"])
})

test("[BROWSER-VIDEO-002] undo and discard restore a deleted active scene", async ({ owner }) => {
  const source =
    '<main data-derive-video><section data-derive-scene="a" data-duration-ms="5000"><h2>A</h2></section>' +
    '<section data-derive-scene="b" data-duration-ms="5000"><h2>B</h2></section>' +
    '<section data-derive-scene="c" data-duration-ms="5000"><h2>C</h2></section></main>'
  const shortId = await publishArtifact(owner, "deleted-active-scene.html", source, "text/html")
  await openArtifact(owner, shortId)
  await owner.getByTestId("video-next").click()
  await expect(frame(owner).locator("[data-derive-video-active]")).toHaveText("B")

  await enterEditMode(owner)
  await owner.getByTestId("artifact-inspect-scene-delete").click()
  await expect(frame(owner).locator("[data-derive-video-active]")).toHaveText("C")
  await owner.getByTestId("inline-edit-undo").click()
  await expect(frame(owner).locator("[data-derive-video-active]")).toHaveText("B")

  await owner.getByTestId("artifact-inspect-scene-delete").click()
  await expect(frame(owner).locator("[data-derive-video-active]")).toHaveText("C")
  await owner.getByTestId("inline-edit-discard").click()
  await expect(frame(owner).locator("[data-derive-video-active]")).toHaveText("B")
  expect(await contentOf(owner, shortId)).toBe(source)
})

/** Save inline edits while `publish` lands a concurrent version: the browser's save is
 *  held after it is built, the other publish goes through the API, then it proceeds. */
const saveAcross = async (page: Page, shortId: string, publish: () => Promise<void>) => {
  let captured!: () => void
  let release!: () => void
  const saveCaptured = new Promise<void>((resolve) => {
    captured = resolve
  })
  const releaseSave = new Promise<void>((resolve) => {
    release = resolve
  })
  let delayed = false
  await page.route(`**/v1/artifacts/${shortId}/versions`, async (route) => {
    if (!delayed && route.request().method() === "POST") {
      delayed = true
      captured()
      await releaseSave
    }
    await route.continue()
  })
  await page.getByTestId("inline-edit-save").click()
  await saveCaptured
  await publish()
  release()
}

test("[BROWSER-CONCURRENCY-001] a concurrent publish elsewhere merges; one to the same element conflicts", async ({
  owner,
}) => {
  const v1 = '<h1>Concurrent</h1><p id="mine">My paragraph.</p><p>Original external line.</p>'
  const shortId = await publishArtifact(owner, "concurrent.html", v1, "text/html")
  const publish = (html: string) => async () => {
    const external = await owner.request.post(`/v1/artifacts/${shortId}/versions`, {
      multipart: {
        file: { name: "concurrent.html", mimeType: "text/html", buffer: Buffer.from(html) },
        message: "Concurrent external publish",
      },
    })
    expect(external.ok(), `external publish failed: ${external.status()}`).toBeTruthy()
  }
  await openArtifact(owner, shortId)
  await enterEditMode(owner)
  await frame(owner).locator("#mine").click()
  await owner.keyboard.press("End")
  await owner.keyboard.type(" Pending edit.")
  const sha = () => frame(owner).locator("html").getAttribute("data-derive-src-sha")
  const served = await sha()

  // Another line changed under the save: the paragraph it names is byte-identical at
  // head, so the save lands there and keeps both.
  await saveAcross(
    owner,
    shortId,
    publish(v1.replace("Original external line.", "Changed externally.")),
  )
  await expect(async () => {
    const stored = await contentOf(owner, shortId)
    expect(stored).toContain("My paragraph. Pending edit.")
    expect(stored).toContain("Changed externally.")
  }).toPass({ timeout: 10_000 })
  await owner.unroute(`**/v1/artifacts/${shortId}/versions`)

  // The same paragraph changed under the save: nothing is saved, the typing stays on
  // the page, and saving again says which element conflicts.
  await expect(frame(owner).locator("#mine")).toHaveText("My paragraph. Pending edit.")
  const head = await contentOf(owner, shortId)
  // The session picks back up on the saved page.
  await expect.poll(() => sha().catch(() => served)).not.toBe(served)
  await expect(owner.getByTestId("inline-edit-bar")).toBeVisible()
  await frame(owner).locator("#mine").click()
  await owner.keyboard.press("End")
  await owner.keyboard.type(" Mine again.")
  await saveAcross(owner, shortId, publish(head.replace("My paragraph.", "Their paragraph.")))
  const conflict = owner.getByText("The artifact changed while you were editing.", { exact: true })
  await expect(conflict).toBeVisible()
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("1 unsaved change")
  await expect(frame(owner).locator("#mine")).toContainText("Mine again.")
  await owner.getByTestId("inline-edit-save").click()
  await expect(
    owner.locator("[data-sonner-toast]").filter({ hasText: /element \d+/ }),
  ).toBeVisible()
  await expect(owner.getByTestId("inline-edit-bar")).toContainText("1 unsaved change")
  expect(await contentOf(owner, shortId)).toContain("Their paragraph.")
})

/* The exact-source serializer (packages/core/src/source-tokens.ts), against what a real
   browser does to the DOM while someone edits. Each case stamps a document the way the
   server serves it to an editor, snapshots it like edit mode does, lets Chromium mutate
   it, and applies the collected ops to the stored source with the server's own
   applySourceOps. The saved source must read exactly like the edited page, and every
   byte outside the edited elements must be unchanged. */
test.describe("exact-source serializer", () => {
  const SERIALIZER = buildSync({
    entryPoints: [
      fileURLToPath(new URL("../../../../packages/core/src/source-tokens.ts", import.meta.url)),
    ],
    bundle: true,
    format: "iife",
    globalName: "__src",
    write: false,
  }).outputFiles[0]?.text as string
  type Tok = { text?: string; keep?: number; tag?: string; href?: string; children?: Tok[] }
  type Op = { op: string; src: number; children?: Tok[]; hash?: string; style?: string | null }

  /** Load `src` stamped, let `before` play the page's own script, snapshot it like
   *  edit mode does, and make `[data-edit]` contenteditable. */
  const open = async (
    page: Page,
    src: string,
    { mode = "plaintext-only", before = () => {} } = {},
  ) => {
    await page.setContent(stampSourceIds(src, { version: 1, sha: "x" }))
    await page.evaluate(before)
    await page.addScriptTag({ content: SERIALIZER })
    await page.evaluate(
      ([sel, m]) => {
        const w = window as unknown as {
          __snap: unknown
          __src: { snapshotSource: (r: Element) => unknown }
        }
        w.__snap = w.__src.snapshotSource(document.body)
        for (const el of document.querySelectorAll(sel as string))
          el.setAttribute("contenteditable", m as string)
      },
      ["[data-edit]", mode],
    )
  }
  const collect = (page: Page) =>
    page.evaluate(() => {
      const w = window as unknown as {
        __snap: unknown
        __src: { collectSourceOps: (r: Element, s: unknown) => { ops: Op[]; ok: boolean } }
      }
      return w.__src.collectSourceOps(document.body, w.__snap)
    })
  const text = (page: Page) =>
    page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").trim())

  /** Collect, apply as the server does, render the result, and compare with the page. */
  const roundTrip = async (page: Page, src: string) => {
    const { ops, ok } = await collect(page)
    expect(ok).toBe(true)
    const { hashes } = await sourceMap(src)
    const hash = (t: Tok): Tok => ({
      ...t,
      ...(t.keep !== undefined && { hash: hashes[t.keep] }),
      ...(t.children && { children: t.children.map(hash) }),
    })
    const sent = ops.map((o) => ({
      ...o,
      hash: hashes[o.src],
      ...(o.children && { children: o.children.map(hash) }),
    }))
    const { html } = await applySourceOps(src, sent)
    const edited = await text(page)
    await page.setContent(html)
    expect(await text(page)).toBe(edited)
    return { ops, html }
  }
  const selectText = (page: Page, from: [string, number], to: [string, number]) =>
    page.evaluate(
      ([a, b]) => {
        const at = ([sel, off]: [string, number]) => {
          const el = document.querySelector(sel) as Element
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
          let n = walker.nextNode() as Text
          let o = off
          while (o > n.data.length) {
            o -= n.data.length
            n = walker.nextNode() as Text
          }
          return [n, o] as const
        }
        const r = document.createRange()
        r.setStart(...at(a as [string, number]))
        r.setEnd(...at(b as [string, number]))
        const s = getSelection() as Selection
        s.removeAllRanges()
        s.addRange(r)
      },
      [from, to],
    )

  test("typing: one op on the element typed in, carrying only its children", async ({ page }) => {
    const src =
      '<body><main><p id="a" data-edit>Hello world</p><p>Other &amp; kept</p></main></body>'
    await open(page, src)
    await page.locator("#a").click()
    await page.keyboard.press("End")
    await page.keyboard.type(" & more <b>")
    const { ops, html } = await roundTrip(page, src)
    expect(ops).toEqual([
      { op: "content", src: 2, hash: "", children: [{ text: "Hello world & more <b>" }] },
    ])
    expect(html).toBe(src.replace("Hello world", "Hello world &amp; more &lt;b&gt;"))
  })

  test("deleting across elements and a <br> merges them, and keeps what's left verbatim", async ({
    page,
  }) => {
    const src =
      '<body><div class="card" data-edit><span class="n">01</span><h3>Juliet<br>Kilo Lima</h3><p>Mike <em>november</em> oscar</p></div><p>After</p></body>'
    await open(page, src)
    await page.locator(".card").focus()
    await selectText(page, ["h3", 3], ["p", 7])
    await page.keyboard.press("Backspace")
    const { ops, html } = await roundTrip(page, src)
    expect(ops).toHaveLength(1)
    expect(html.startsWith('<body><div class="card" data-edit><span class="n">01</span><h3>')).toBe(
      true,
    )
    expect(html.endsWith("<p>After</p></body>")).toBe(true)
    expect(html).not.toContain("<br>")
  })

  test("Enter in a browser-owned block becomes a <br>, never an invented div", async ({ page }) => {
    const src = '<body><div id="a" data-edit>First line</div></body>'
    await open(page, src, { mode: "true" })
    await page.locator("#a").click()
    await page.keyboard.press("End")
    await page.keyboard.press("Enter")
    await page.keyboard.type("Second")
    const { html } = await roundTrip(page, src)
    expect(html).toBe('<body><div id="a" data-edit>First line<br>Second</div></body>')
  })

  test("⌘A and retype replaces the element's children, <br> included", async ({ page }) => {
    const src = '<body><h3 id="a" data-edit>Old<br>heading</h3><p>Stay</p></body>'
    await open(page, src)
    await page.locator("#a").click()
    await page.keyboard.press("ControlOrMeta+a")
    await page.keyboard.type("New")
    const { ops, html } = await roundTrip(page, src)
    expect(ops).toEqual([{ op: "content", src: 1, hash: "", children: [{ text: "New" }] }])
    expect(html).toBe('<body><h3 id="a" data-edit>New</h3><p>Stay</p></body>')
  })

  test("the editor's bold, italic and link spans become the allowed tags", async ({ page }) => {
    const src = '<body><p id="a" data-edit>one two three four</p></body>'
    await open(page, src)
    await page.evaluate(() => {
      const t = (document.querySelector("#a") as Element).firstChild as Text
      const wrap = (start: number, end: number, fmt: string, href?: string) => {
        const r = document.createRange()
        r.setStart(t.parentNode?.firstChild as Text, start)
        r.setEnd(t.parentNode?.firstChild as Text, end)
        const s = document.createElement("span")
        s.setAttribute("data-derive-fmt", fmt)
        if (href) s.setAttribute("data-derive-href", href)
        r.surroundContents(s)
      }
      wrap(14, 18, "a", "https://example.com/?a=1&b=2")
      wrap(8, 13, "i")
      wrap(4, 7, "b")
    })
    const { html } = await roundTrip(page, src)
    expect(html).toBe(
      '<body><p id="a" data-edit>one <b>two</b> <i>three</i> <a href="https://example.com/?a=1&amp;b=2">four</a></p></body>',
    )
  })

  test("browser-invented spans and pasted markup are unwrapped to their words", async ({
    page,
  }) => {
    const src = '<body><div id="a" data-edit>Start end</div></body>'
    await open(page, src, { mode: "true" })
    await page.locator("#a").click()
    await selectText(page, ["#a", 6], ["#a", 6])
    await page.evaluate(() =>
      document.execCommand(
        "insertHTML",
        false,
        '<span style="color:red">red</span> <font size="5">big</font><div>block <strong>strong</strong></div><script>x()</script>',
      ),
    )
    const { html } = await roundTrip(page, src)
    expect(html.replace('<div id="a" data-edit>', "")).not.toMatch(/<(?:span|font|div|script)\b/)
    expect(html).not.toContain("x()")
    expect(html).toContain("<strong>strong</strong>")
  })

  test("a reorder keeps every moved element's bytes; a duplicate keeps it twice", async ({
    page,
  }) => {
    const src =
      '<body><section id="r"><div class="a" style="color:red">A &amp; a</div>\n  <div class="b">B<!-- note --></div>\n  <div class="c">C</div></section></body>'
    await open(page, src)
    await page.evaluate(() => {
      const r = document.querySelector("#r") as Element
      r.insertBefore(r.querySelector(".c") as Element, r.querySelector(".a"))
      ;(r.querySelector(".b") as Element).after((r.querySelector(".a") as Element).cloneNode(true))
    })
    const { ops, html } = await roundTrip(page, src)
    expect(ops).toEqual([
      {
        op: "content",
        src: 1,
        hash: "",
        children: [
          { keep: 4, hash: "" },
          { keep: 2, hash: "" },
          { text: "\n  " },
          { keep: 3, hash: "" },
          { keep: 2, hash: "" },
          { text: "\n  " },
        ],
      },
    ])
    expect(html).toContain('<div class="b">B<!-- note --></div>')
    expect(html.match(/<div class="a" style="color:red">A &amp; a<\/div>/g)).toHaveLength(2)
  })

  test("what a page script made is never written; source it swallowed refuses the save", async ({
    page,
  }) => {
    const src = '<body><p id="a" data-edit>Words</p><div id="b"><p>Held</p></div></body>'
    await open(page, src, {
      before: () => {
        const n = document.createElement("span")
        n.textContent = " (generated)"
        document.querySelector("#a")?.append(n)
      },
    })
    await page.evaluate(() => document.querySelector("#a")?.prepend("New "))
    const { ops } = await collect(page)
    expect(ops).toEqual([{ op: "content", src: 1, hash: "", children: [{ text: "New Words" }] }])
    // A script that wraps source in its own element leaves nothing a save can say.
    await page.evaluate(() => {
      const b = document.querySelector("#b") as Element
      const wrap = document.createElement("div")
      wrap.setAttribute("data-derive-generated", "")
      wrap.append(...b.childNodes)
      b.append(wrap)
    })
    expect((await collect(page)).ok).toBe(false)
  })
})

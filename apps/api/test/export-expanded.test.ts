import { DECK_CONTENT_TYPE, INTERNAL_DELIVERY } from "@derive/core"
import { unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { runExportTick } from "../src/exports"
import {
  buildExportEmail,
  csvFromJson,
  type ExportKind,
  exportInputHash,
  imageBackedPptx,
  isQaEmailRecipient,
  normalizeExportOptions,
} from "../src/lib/export-system"
import { as, makeAuthedApp, publishAs, type TestUser } from "./helpers"

const owner: TestUser = {
  id: "expanded-export-owner",
  email: "expanded-export-owner@test.dev",
  name: "Expanded Export Owner",
}

const makeFixture = (name: string) =>
  makeAuthedApp(name, [owner], undefined, {
    deps: { renderExports: true, qaEmailCapture: true },
  })

const postExport = (
  target: ReturnType<typeof makeFixture>["app"],
  shortId: string,
  body: Record<string, unknown>,
) =>
  target.request(`/v1/artifacts/${shortId}/exports`, {
    method: "POST",
    headers: { ...as(owner.email), "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("expanded export and email dogfood contracts", () => {
  it("C09 rejects unsupported format pairings and incomplete requests precisely", async () => {
    const { app } = makeFixture("expanded-format-matrix")
    const artifact = await (
      await publishAs(
        app,
        "<h1>Ordinary page</h1>",
        { title: "Format matrix", workspace_access: "none" },
        as(owner.email),
      )
    ).json()

    for (const kind of ["deck_pdf", "deck_pptx"] satisfies ExportKind[]) {
      const response = await postExport(app, artifact.short_id, { kind })
      expect(response.status).toBe(400)
      expect(await response.text()).toContain("requires a Derive deck")
    }
    for (const kind of ["chart_json", "chart_csv"] satisfies ExportKind[]) {
      const response = await postExport(app, artifact.short_id, { kind })
      expect(response.status).toBe(400)
      expect(await response.text()).toContain("dataSlot is required")
    }
    const missingRecipient = await postExport(app, artifact.short_id, { kind: "email" })
    expect(missingRecipient.status).toBe(400)
    expect(await missingRecipient.text()).toContain("recipient is required")
    const invalidPreview = await postExport(app, artifact.short_id, {
      kind: "page_pdf",
      preview: true,
    })
    expect(invalidPreview.status).toBe(400)
    expect(await invalidPreview.text()).toContain("preview is only supported for email")
    expect((await postExport(app, artifact.short_id, { kind: "not-a-format" })).status).toBe(400)
  })

  it("C12 normalizes awkward Unicode input without changing its immutable key accidentally", async () => {
    const normalized = normalizeExportOptions({
      recipient: "  QA+Résumé@EXAMPLE.TEST ",
      region: "  #売上-chart  ",
      dataSlot: "  الإيرادات  ",
      title: "  Résumé 東京 — مرحبًا  ",
      note: `  ${"🧪".repeat(1_100)}  `,
    })
    expect(normalized).toMatchObject({
      recipient: "qa+résumé@example.test",
      region: "#売上-chart",
      dataSlot: "الإيرادات",
      title: "Résumé 東京 — مرحبًا",
    })
    expect(normalized.note?.length).toBe(2_000)

    const base = {
      artifactId: "a-unicode",
      version: 7,
      requestedBy: "u-owner",
      rendererScope: "https://preview.test",
      kind: "email" as const,
    }
    expect(
      await exportInputHash({
        ...base,
        options: { recipient: " QA+Résumé@EXAMPLE.TEST ", title: " Résumé 東京 — مرحبًا " },
      }),
    ).toBe(
      await exportInputHash({
        ...base,
        options: { recipient: "qa+résumé@example.test", title: "Résumé 東京 — مرحبًا" },
      }),
    )
  })

  it("C12 serializes quotes, newlines, Unicode, sparse columns and nested values losslessly", () => {
    expect(
      csvFromJson([
        { label: "Résumé, 東京", note: "line 1\nline 2", value: 4, meta: { unit: "€" } },
        { label: 'She said "yes"', value: null, extra: "مرحبا" },
      ]),
    ).toBe(
      'label,note,value,meta,extra\r\n"Résumé, 東京","line 1\nline 2",4,"{""unit"":""€""}",\r\n"She said ""yes""",,,,مرحبا',
    )
  })

  it("C14 coalesces normalized replays but separates formats, recipients and hosting modes", async () => {
    const base = {
      artifactId: "a1",
      version: 3,
      requestedBy: "u1",
      rendererScope: "https://preview.test",
    }
    const hash = (kind: ExportKind, options: Parameters<typeof exportInputHash>[0]["options"]) =>
      exportInputHash({ ...base, kind, options })
    expect(await hash("chart_png", { region: " #chart " })).toBe(
      await hash("chart_png", { region: "#chart" }),
    )
    expect(await hash("chart_png", { region: "#chart" })).not.toBe(
      await hash("page_pdf", { region: "#chart" }),
    )
    expect(await hash("email", { recipient: "one@example.test", publicImage: false })).not.toBe(
      await hash("email", { recipient: "one@example.test", publicImage: true }),
    )
    expect(await hash("email", { recipient: "one@example.test" })).not.toBe(
      await hash("email", { recipient: "two@example.test" }),
    )
  })

  it("C14 atomically coalesces simultaneous identical requests", async () => {
    const { app } = makeFixture("expanded-concurrent-replay")
    const artifact = await (
      await publishAs(
        app,
        '<script type="application/derive+json" data-name="series">[{"x":1}]</script>',
        { title: "Concurrent replay", workspace_access: "none" },
        as(owner.email),
      )
    ).json()
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        postExport(app, artifact.short_id, { kind: "chart_json", dataSlot: "series" }),
      ),
    )
    expect(new Set(responses.map((response) => response.status))).toEqual(new Set([202]))
    const jobs = await Promise.all(responses.map((response) => response.json()))
    expect(new Set(jobs.map((job) => job.id))).toHaveLength(1)
  })

  it("C16/C17 keeps hostile email static, compact, readable, escaped and header-safe", () => {
    const title = 'Résumé 東京\r\nBcc: attacker@example.com <script>alert("x")</script>'
    const email = buildExportEmail({
      to: "qa@example.test",
      title,
      note: '<img src=x onerror=alert(1)> مرحبًا & "quoted"',
      openUrl: "https://derive.test/artifacts/a?x=1&y=2",
      imageUrl: "cid:derive-export",
      alt: 'Revenue <svg onload="bad">',
      version: 9,
    })
    expect(email.subject).not.toMatch(/[\r\n]/)
    expect(email.html).not.toContain("<script>")
    expect(email.html).not.toContain("<img src=x")
    expect(email.html).toContain("&lt;script&gt;")
    expect(email.html).toContain("Résumé 東京")
    expect(email.html).toContain("مرحبًا")
    expect(email.html).toContain("Open in Derive")
    expect(email.text).toContain("Open: https://derive.test/artifacts/a?x=1&y=2")
    expect(new TextEncoder().encode(email.html).byteLength).toBeLessThan(20_000)
  })

  it("C17 limits preview capture to the reserved .test namespace", () => {
    for (const address of ["qa@example.test", "QA@SUB.EXAMPLE.TEST", "user@xn--x.test"])
      expect(isQaEmailRecipient(address)).toBe(true)
    for (const address of ["qa@example.com", "qa@test.example.com", "qa@example.testing", ""])
      expect(isQaEmailRecipient(address)).toBe(false)
  })

  it("C13 switches an oversized PDF attachment to a safe artifact link", async () => {
    const { app, meta, ctx } = makeFixture("expanded-large-email")
    const artifact = await (
      await publishAs(
        app,
        "<h1>Large attachment</h1>",
        { title: "Large attachment", workspace_access: "none" },
        as(owner.email),
      )
    ).json()
    const accepted = await postExport(app, artifact.short_id, {
      kind: "email",
      recipient: "qa@example.test",
      attachPdf: true,
    })
    expect(accepted.status).toBe(202)
    const job = await accepted.json()
    expect(
      await runExportTick({
        meta,
        blobs: ctx.blobs,
        renderer: {
          screenshot: async () => new Uint8Array([1, 2, 3]),
          pdf: async () => new Uint8Array(8 * 1024 * 1024 + 1),
        },
        baseUrl: "http://derive.test",
        secret: "expanded-large-email-secret",
      }),
    ).toBe(1)
    const capture = await app.request(`/v1/exports/${job.id}/preview`, {
      headers: as(owner.email),
    })
    expect(capture.status).toBe(200)
    const html = await capture.text()
    expect(html).toContain("exceeded the safe email attachment limit")
    expect(html).toContain("derive-export.png")
    expect(html).not.toContain("derive-export.pdf")
  })

  it("renders a deck's declared email-layout as native HTML without taking a screenshot", async () => {
    const { app, meta, ctx } = makeFixture("expanded-rich-html-email")
    const layout = {
      schema: "derive.email/v1",
      preheader: "Pipeline pulse",
      title: "Pipeline pulse — native HTML",
      subtitle: "Charts remain readable when images are blocked.",
      blocks: [
        {
          type: "kpis",
          items: [
            { label: "Qualified pipeline", value: "$8.4M", delta: "+14%" },
            { label: "Coverage", value: "3.1×" },
          ],
        },
        {
          type: "bars",
          title: "Pipeline by segment",
          items: [
            { label: "Enterprise", value: 84, display: "$4.2M" },
            { label: "Mid-market", value: 56, display: "$2.8M" },
          ],
        },
      ],
    }
    const artifact = await (
      await publishAs(
        app,
        `<section class="slide" data-derive-slide="0"><h1>Pipeline pulse</h1></section><section class="slide" data-derive-slide="1"><h1>Next step</h1></section><script>parent.postMessage({source:"derive-deck",type:"state",i:0,total:2},"*")</script><script type="application/derive-facts" data-fact="email-layout">${JSON.stringify(layout)}</script>`,
        { title: "Pipeline pulse", workspace_access: "none" },
        as(owner.email),
      )
    ).json()
    expect(artifact.current_content_type).toBe(DECK_CONTENT_TYPE)
    const accepted = await postExport(app, artifact.short_id, {
      kind: "email",
      recipient: "qa@example.test",
      emailMode: "auto",
    })
    expect(accepted.status).toBe(202)
    const job = await accepted.json()
    let screenshots = 0
    expect(
      await runExportTick({
        meta,
        blobs: ctx.blobs,
        renderer: {
          screenshot: async () => {
            screenshots += 1
            return new Uint8Array([1, 2, 3])
          },
        },
        baseUrl: "http://derive.test",
        secret: "expanded-rich-html-secret",
      }),
    ).toBe(1)
    expect(screenshots).toBe(0)
    const capture = await app.request(`/v1/exports/${job.id}/preview`, {
      headers: as(owner.email),
    })
    expect(capture.status).toBe(200)
    const html = await capture.text()
    expect(html).toContain("Pipeline pulse — native HTML")
    expect(html).toContain("$8.4M")
    expect(html).toContain("Enterprise")
    expect(html).not.toContain("data:image/png")
    expect(html).toContain("<li>None</li>")
  })

  it("previews a production email without a recipient or delivery side effect", async () => {
    const { app, meta, ctx } = makeAuthedApp("expanded-public-email-preview", [owner], undefined, {
      deps: { renderExports: true },
    })
    const layout = {
      schema: "derive.email/v1",
      title: "No-send preview",
      blocks: [
        { type: "kpis", items: [{ label: "ARR", value: "$12.4M" }] },
        { type: "paragraph", body: "This exact HTML can be inspected before delivery." },
      ],
    }
    const artifact = await (
      await publishAs(
        app,
        `<h1>No-send preview</h1><script type="application/derive-facts" data-fact="email-layout">${JSON.stringify(layout)}</script>`,
        { title: "No-send preview", workspace_access: "none" },
        as(owner.email),
      )
    ).json()
    const requests = await Promise.all([
      postExport(app, artifact.short_id, { kind: "email", preview: true }),
      postExport(app, artifact.short_id, {
        kind: "email",
        recipient: "real-address@example.com",
        preview: true,
      }),
    ])
    expect(requests.map((response) => response.status)).toEqual([202, 202])
    const jobs = await Promise.all(requests.map((response) => response.json()))
    expect(new Set(jobs.map((job) => job.id))).toHaveLength(1)
    const [job] = jobs
    const queued = await meta.getExportJob(job.id)
    expect(JSON.parse(queued?.options_json ?? "{}")).toMatchObject({
      recipient: "preview@derive.test",
      qaCapture: true,
    })
    expect(
      await runExportTick({
        meta,
        blobs: ctx.blobs,
        renderer: {
          screenshot: async () => {
            throw new Error("native HTML preview must not take a screenshot")
          },
        },
        baseUrl: "http://derive.test",
        secret: "expanded-public-preview-secret",
      }),
    ).toBe(1)
    expect(await meta.recentDeliveries(INTERNAL_DELIVERY, 10)).toEqual([])

    const capture = await app.request(`/v1/exports/${job.id}/preview`, {
      headers: as(owner.email),
    })
    expect(capture.status).toBe(200)
    expect(capture.headers.get("content-security-policy")).toContain("sandbox")
    const html = await capture.text()
    expect(html).toContain("QA capture · no email was sent")
    expect(html).toContain("preview@derive.test")
    expect(html).toContain("$12.4M")
  })

  it("renders a deck email snapshot from the first native deck image and sends PNG bytes", async () => {
    const { app, meta, ctx } = makeAuthedApp("expanded-deck-email-snapshot", [owner], undefined, {
      deps: { renderExports: true },
    })
    const deck =
      '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body>' +
      '<section class="slide" data-derive-slide="0"><h1>First slide</h1></section>' +
      '<section class="slide" data-derive-slide="1"><h1>Second slide</h1></section>' +
      '<script>parent.postMessage({source:"derive-deck",type:"state",i:0,total:2},"*")</script>' +
      "</body></html>"
    const artifact = await (
      await publishAs(
        app,
        deck,
        { title: "Deck snapshot", workspace_access: "none" },
        as(owner.email),
      )
    ).json()
    const accepted = await postExport(app, artifact.short_id, {
      kind: "email",
      recipient: "qa@example.test",
      emailMode: "auto",
    })
    expect(accepted.status).toBe(202)
    const job = await accepted.json()
    let screenshots = 0
    let deckCalls = 0
    const deckPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01])
    expect(
      await runExportTick({
        meta,
        blobs: ctx.blobs,
        renderer: {
          screenshot: async () => {
            screenshots += 1
            throw new Error("generic screenshot must not render a deck email snapshot")
          },
          deckImages: async (url, timeoutMs) => {
            deckCalls += 1
            expect(url).toContain("/raw/")
            expect(timeoutMs).toBe(20_000)
            return [deckPng, new Uint8Array([2])]
          },
        },
        baseUrl: "http://derive.test",
        secret: "expanded-deck-email-secret",
      }),
    ).toBe(1)
    expect(deckCalls).toBe(1)
    expect(screenshots).toBe(0)

    const finished = await meta.getExportJob(job.id)
    expect(finished?.status).toBe("ready")
    expect(finished?.output_type).toBe("image/png")
    expect(finished?.output_key).toBeTruthy()
    expect(await ctx.blobs.get(finished?.output_key as string)).toEqual(deckPng)

    const [delivery] = await meta.recentDeliveries(INTERNAL_DELIVERY, 10)
    expect(delivery?.id).toBe(`wd_export_${job.id}`)
    expect(JSON.parse(delivery?.payload ?? "{}")).toMatchObject({
      to: "qa@example.test",
      attachments: [
        { filename: "derive-export.png", contentType: "image/png", contentId: "derive-export" },
      ],
    })
  })

  it("C18 replays CID and hosted delivery independently without duplicate jobs", async () => {
    const { app } = makeFixture("expanded-email-replay")
    const artifact = await (
      await publishAs(
        app,
        "<h1>Email replay</h1>",
        { title: "Email replay", workspace_access: "none" },
        as(owner.email),
      )
    ).json()
    const cid = () =>
      postExport(app, artifact.short_id, {
        kind: "email",
        recipient: "qa@example.test",
        publicImage: false,
      })
    const hosted = () =>
      postExport(app, artifact.short_id, {
        kind: "email",
        recipient: "qa@example.test",
        publicImage: true,
      })
    const [cidA, cidB, hostedA, hostedB] = await Promise.all([cid(), cid(), hosted(), hosted()])
    const [a, b, c, d] = await Promise.all([
      cidA.json(),
      cidB.json(),
      hostedA.json(),
      hostedB.json(),
    ])
    expect(a.id).toBe(b.id)
    expect(c.id).toBe(d.id)
    expect(a.id).not.toBe(c.id)
  })

  it("C12/C06 keeps Unicode provenance XML-safe in an exact 16:9 PPTX package", () => {
    const pptx = unzipSync(
      imageBackedPptx(
        [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])],
        "Résumé 東京 & مرحبًا <v2> 'quoted'",
      ),
    )
    const text = new TextDecoder()
    const core = text.decode(pptx["docProps/core.xml"])
    const presentation = text.decode(pptx["ppt/presentation.xml"])
    expect(core).toContain("Résumé 東京 &amp; مرحبًا &lt;v2&gt; &apos;quoted&apos;")
    expect(presentation).toContain('type="screen16x9"')
    expect(
      Object.keys(pptx).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path)),
    ).toHaveLength(3)
  })
})

import { describe, expect, it } from "vitest"
import { app, upload } from "./helpers"

// End-to-end: mobile auto-reflow is OPT-IN per artifact ([Q2], 2026-07-13). By
// default a viewport-less page serves byte-faithful — exactly as authored; a
// publisher passes reflow=true to let Derive inject the viewport tag + reflow CSS
// at serve time. Already-responsive HTML and markdown are never touched either way.
const raw = async (shortId: string) => (await app.request(`/raw/${shortId}/v/1/index.html`)).text()

const publish = async (
  name: string,
  content: string,
  fields: Record<string, string> = {},
): Promise<string> => (await (await upload(name, content, fields)).json()).short_id as string

const FIXED_WIDTH_HTML =
  "<!doctype html><html><head><title>Report</title></head>" +
  '<body><div style="width:1200px">wide</div></body></html>'

describe("serve-time HTML auto-reflow (opt-in)", () => {
  it("BY DEFAULT serves a viewport-less page byte-faithful — no injection (the [Q2] flip)", async () => {
    const body = await raw(await publish("report.html", FIXED_WIDTH_HTML))
    expect(body).not.toContain("data-derive-reflow")
    expect(body).not.toContain('name="viewport"')
    // Content and the anchor client are untouched by the flip.
    expect(body).toContain("wide")
    expect(body).toContain("derive-client.js")
  })

  it("publishing with reflow=true opts in: viewport + reflow CSS are injected", async () => {
    const body = await raw(await publish("report.html", FIXED_WIDTH_HTML, { reflow: "true" }))
    expect(body).toContain('name="viewport"')
    expect(body).toContain("width=device-width")
    expect(body).toContain("data-derive-reflow")
    expect(body).toContain("wide")
    expect(body).toContain("derive-client.js")
  })

  it("even opted-in, an already-responsive page is left alone (detection still gates)", async () => {
    const html =
      '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">' +
      "<title>Responsive</title></head><body>hi</body></html>"
    const body = await raw(await publish("responsive.html", html, { reflow: "true" }))
    expect(body).not.toContain("data-derive-reflow")
    // Exactly the one viewport the author wrote — we didn't add a second.
    expect(body.match(/name="viewport"/g)).toHaveLength(1)
  })

  it("does not touch markdown-rendered output (already responsive) or double-add a viewport", async () => {
    const body = await raw(
      await publish("notes.md", "# Notes\n\nSome **text** and a list:\n\n- a\n- b\n"),
    )
    expect(body).not.toContain("data-derive-reflow")
    expect(body.match(/name="viewport"/g)).toHaveLength(1)
    expect(body).toContain("<h1") // it really did render markdown
  })
})

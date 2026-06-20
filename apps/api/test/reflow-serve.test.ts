import { describe, expect, it } from "vitest"
import { app, upload } from "./helpers"

// End-to-end: a non-mobile-optimized HTML artifact gets the viewport tag + reflow CSS
// injected at serve time, while already-responsive HTML and markdown are left alone.
const raw = async (shortId: string) => (await app.request(`/raw/${shortId}/v/1/index.html`)).text()

const publish = async (name: string, content: string): Promise<string> =>
  (await (await upload(name, content)).json()).short_id as string

describe("serve-time HTML auto-reflow", () => {
  it("injects viewport + reflow CSS into a fixed-width page with no viewport", async () => {
    const html =
      "<!doctype html><html><head><title>Report</title></head>" +
      '<body><div style="width:1200px">wide</div></body></html>'
    const body = await raw(await publish("report.html", html))
    expect(body).toContain('name="viewport"')
    expect(body).toContain("width=device-width")
    expect(body).toContain("data-dock-reflow")
    // Original content is preserved; the anchor client is still appended.
    expect(body).toContain("wide")
    expect(body).toContain("dock-client.js")
  })

  it("leaves an already-responsive page alone (no reflow injected)", async () => {
    const html =
      '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">' +
      "<title>Responsive</title></head><body>hi</body></html>"
    const body = await raw(await publish("responsive.html", html))
    expect(body).not.toContain("data-dock-reflow")
    // Exactly the one viewport the author wrote — we didn't add a second.
    expect(body.match(/name="viewport"/g)).toHaveLength(1)
  })

  it("does not touch markdown-rendered output (already responsive) or double-add a viewport", async () => {
    const body = await raw(
      await publish("notes.md", "# Notes\n\nSome **text** and a list:\n\n- a\n- b\n"),
    )
    expect(body).not.toContain("data-dock-reflow")
    expect(body.match(/name="viewport"/g)).toHaveLength(1)
    expect(body).toContain("<h1") // it really did render markdown
  })
})

describe("serve-time Reader view (?reader=1)", () => {
  const rawReader = async (shortId: string) =>
    (await app.request(`/raw/${shortId}/v/1/index.html?reader=1`)).text()

  it("re-renders a fixed-layout page clean + responsive, dropping author layout", async () => {
    const html =
      "<!doctype html><html><head><title>Spec</title>" +
      "<style>.page{width:1100px}</style></head>" +
      '<body><div class="page" style="width:1100px"><h2>Heading</h2>' +
      "<p>readable body text</p></div></body></html>"
    const id = await publish("spec.html", html)
    const body = await rawReader(id)
    expect(body).toContain("width=device-width") // Dock responsive shell
    expect(body).toContain("<main>")
    expect(body).toContain("Heading")
    expect(body).toContain("readable body text")
    expect(body).not.toContain("1100px") // author fixed layout gone
  })
})

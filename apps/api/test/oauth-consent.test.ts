import { writeFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { consentHTML } from "../src/oauth-consent"

describe("oauth consent screen", () => {
  const html = consentHTML({
    clientName: "Claude Code",
    scopes: ["openid", "derive:read", "derive:propose", "derive:publish"],
    query: "client_id=cli&scope=openid+derive:read&code=abc",
  })

  it("renders the authorize card with the client name and scope labels", () => {
    expect(html).toContain("wants to act in your workspace")
    expect(html).toContain("Claude Code")
    expect(html).toContain("Read your artifacts and comments")
    expect(html).toContain("Propose new versions")
  })

  it("ships the branded post-approve confirmation card + the goConnected handoff", () => {
    expect(html).toContain("var CONNECTED =")
    expect(html).toContain("function goConnected(")
    // On approve we linger on our card; deny bounces straight back.
    expect(html).toContain("if (!accept){ window.location.href = to; return; }")
    expect(html).toContain("goConnected(to, saved")
    // The success card is embedded JSON-encoded; decode it and assert its markup.
    const connected = JSON.parse(
      (html.match(/var CONNECTED = (".*?");/s)?.[1] as string) ?? '""',
    ) as string
    expect(connected).toContain("You're connected")
    expect(connected).toContain('class="badge ok">Connected')
    expect(connected).toContain('class="done"')
    expect(connected).toContain("Claude Code") // the client name, escaped, in the card
  })

  it("escapes a hostile client name in both the authorize and connected cards", () => {
    const evil = consentHTML({ clientName: "<script>x</script>", scopes: ["openid"], query: "" })
    expect(evil).not.toContain("<script>x</script>")
    expect(evil).toContain("&lt;script&gt;")
  })

  it("never renders the workspace picker — every grant covers all workspaces for now", () => {
    // Multiple workspaces, a clientId to bind to, and an explicit selection:
    // exactly the shape that used to render a <select>. It shouldn't anymore.
    const multi = consentHTML({
      clientName: "Claude Code",
      scopes: ["openid"],
      query: "",
      clientId: "cli_1",
      workspaces: [
        { id: "w1", name: "Personal" },
        { id: "w2", name: "Acme <evil>" },
      ],
      selected: "w2",
    })
    expect(multi).not.toContain('<select id="ws"')
    expect(multi).not.toContain("Default workspace")
    // The rest of the card still renders normally around the absent picker.
    expect(multi).toContain("Claude Code")
    // CLIENT_ID is still threaded through — saveWorkspace() (dead now that
    // #ws never exists) short-circuits on its own `!ws` guard rather than
    // needing this page to know the picker is gone.
    expect(multi).toContain('var CLIENT_ID = "cli_1"')

    // Single workspace, no clientId, no workspaces at all — every shape omits it.
    const single = consentHTML({
      clientName: "Claude Code",
      scopes: ["openid"],
      query: "",
      clientId: "cli_1",
      workspaces: [{ id: "w1", name: "Personal" }],
      selected: "w1",
    })
    expect(single).not.toContain('<select id="ws"')
    const noClient = consentHTML({
      clientName: "Claude Code",
      scopes: ["openid"],
      query: "",
      workspaces: [{ id: "w1", name: "Personal" }], // no clientId
    })
    expect(noClient).not.toContain('<select id="ws"')
    expect(html).not.toContain('<select id="ws"') // no workspaces prop at all
  })

  // Emit preview HTML for visual review (both states), when a target dir is given.
  it("writes preview files", () => {
    const dir = process.env.CONSENT_PREVIEW_DIR
    if (!dir) return
    writeFileSync(`${dir}/consent.html`, html)
    // Swap the card to the connected state the way the script does at runtime.
    const connected = JSON.parse(
      (html.match(/var CONNECTED = (".*?");/s)?.[1] as string) ?? '""',
    ) as string
    const shown = html.replace(
      /<main class="card">[\s\S]*?<\/main>/,
      `<main class="card">${connected}</main>`,
    )
    writeFileSync(`${dir}/consent-connected.html`, shown)
    expect(connected).toContain("You're connected")
  })
})

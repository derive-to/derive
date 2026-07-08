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

  it("labels the manage scope — a manage-grade grant must never render as an unknown blob", () => {
    const managed = consentHTML({
      clientName: "Derive CLI",
      scopes: ["openid", "derive:manage"],
      query: "",
    })
    expect(managed).toContain("Manage agents and contexts")
    expect(managed).toContain("only as far as your workspace role allows")
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

  it("renders the workspace picker with the bound/active workspace preselected", () => {
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
    expect(multi).toContain('<select id="ws"')
    expect(multi).toContain('value="w2" selected')
    expect(multi).toContain("Acme &lt;evil&gt;") // workspace names are escaped
    expect(multi).toContain('var CLIENT_ID = "cli_1"')
    // The binding is saved only after the consent POST succeeds — an abandoned
    // or denied consent must not re-point tokens from an earlier grant.
    expect(multi).toContain("var saved = await saveWorkspace()")
    expect(multi).toContain("goConnected(to, saved")
  })

  it("renders (and binds) a single workspace too — the choice pins the grant", () => {
    const single = consentHTML({
      clientName: "Claude Code",
      scopes: ["openid"],
      query: "",
      clientId: "cli_1",
      workspaces: [{ id: "w1", name: "Personal" }],
      selected: "w1",
    })
    expect(single).toContain('<select id="ws"')
    expect(single).toContain('value="w1" selected')
  })

  it("omits the picker when there is nothing to bind", () => {
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

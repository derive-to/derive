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

  it("renders the multi-select picker: All (default) + a checkbox per workspace, escaped", () => {
    const multi = consentHTML({
      clientName: "Claude Code",
      scopes: ["openid"],
      query: "",
      clientId: "cli_1",
      workspaces: [
        { id: "w1", name: "Personal" },
        { id: "w2", name: "Acme <evil>" },
      ],
    })
    // Two modes + a checkbox per workspace.
    expect(multi).toContain('name="wsmode" value="all"')
    expect(multi).toContain('name="wsmode" value="some"')
    expect(multi).toContain('name="ws" value="w1"')
    expect(multi).toContain('name="ws" value="w2"')
    // "All workspaces" is the default (checked) with no prior grant; the list starts hidden.
    expect(multi).toMatch(/value="all"[^>]*checked/)
    expect(multi).toContain('id="wslist" hidden')
    // Hostile workspace name is escaped in the checkbox label.
    expect(multi).not.toContain("Acme <evil>")
    expect(multi).toContain("Acme &lt;evil&gt;")
    // CLIENT_ID threaded through for saveWorkspace's array POST; 0-selected is blocked.
    expect(multi).toContain('var CLIENT_ID = "cli_1"')
    expect(multi).toContain("Select at least one workspace")
  })

  it("preselects 'Only selected' with the prior grant's set on re-consent", () => {
    const re = consentHTML({
      clientName: "Claude Code",
      scopes: ["openid"],
      query: "",
      clientId: "cli_1",
      workspaces: [
        { id: "w1", name: "Personal" },
        { id: "w2", name: "Acme" },
      ],
      selected: ["w2"], // a prior grant scoped to just w2
    })
    expect(re).toMatch(/value="some"[^>]*checked/) // "some" mode preselected
    expect(re).toMatch(/value="w2"[^>]*checked/) // w2 pre-ticked
    expect(re).not.toContain('id="wslist" hidden') // list is visible
  })

  it("omits the picker for a single-workspace user or when no workspaces are passed", () => {
    const single = consentHTML({
      clientName: "Claude Code",
      scopes: ["openid"],
      query: "",
      clientId: "cli_1",
      workspaces: [{ id: "w1", name: "Personal" }], // one workspace — nothing to choose
    })
    // The rendered picker container is absent (the JS still references wsmode in
    // its querySelectors, so assert on the markup, not the script).
    expect(single).not.toContain('class="ws-access"')
    expect(single).not.toContain('name="ws" value=')
    expect(html).not.toContain('class="ws-access"') // no workspaces prop at all
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

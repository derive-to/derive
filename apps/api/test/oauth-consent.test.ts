import { writeFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { consentHTML } from "../src/oauth-consent"

describe("oauth consent screen", () => {
  const html = consentHTML({
    clientName: "Claude Code",
    scopes: ["openid", "dock:read", "dock:propose", "dock:publish"],
    query: "client_id=cli&scope=openid+dock:read&code=abc",
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
    expect(html).toContain("if (accept) goConnected(to)")
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

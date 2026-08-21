import { describe, expect, it } from "vitest"
import { consentHTML } from "../src/oauth-consent"

describe("oauth consent screen", () => {
  it("labels the manage scope — a manage-grade grant must never render as an unknown blob", () => {
    const managed = consentHTML({
      clientName: "Derive CLI",
      scopes: ["openid", "derive:manage"],
      query: "",
    })
    expect(managed).toContain("Manage agents and contexts")
    expect(managed).toContain("only as far as your workspace role allows")
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
})

import { describe, expect, it } from "vitest"
import { buildManifest } from "../src/github-app-setup"

// Locks the standard-source manifest. New installs query GitHub on demand and deliver the
// events agent triggers start on. Actions write is server-narrowed to workflow discovery, dispatch, status, artifacts,
// and cancellation.
describe("GitHub App manifest", () => {
  const m = buildManifest("https://derive.example.com", "derive.example.com")

  it("delivers the events agent triggers start on to Derive's webhook", () => {
    expect(m.default_events).toEqual([
      "pull_request",
      "push",
      "pull_request_review",
      "release",
      "workflow_run",
    ])
    expect(m.hook_attributes).toEqual({
      url: "https://derive.example.com/v1/github/webhook",
      active: true,
    })
  })

  it("is public so it can install on organizations, not just the owner", () => {
    expect(m.public).toBe(true)
  })

  it("requests repository contents for explicit workflow grants alongside existing tools", () => {
    expect(m.default_permissions).toEqual({
      actions: "write",
      contents: "write",
      metadata: "read",
      pull_requests: "write",
    })
  })

  it("uses setup + authorization callbacks without automatic OAuth-on-install", () => {
    expect(m.setup_url).toBe("https://derive.example.com/v1/github/callback")
    expect(m.setup_on_update).toBe(true)
    expect(m.callback_urls).toEqual(["https://derive.example.com/v1/github/authorize"])
    expect(m.request_oauth_on_install).toBe(false)
    expect(m.redirect_url).toBe("https://derive.example.com/settings/github/app/created")
  })
})

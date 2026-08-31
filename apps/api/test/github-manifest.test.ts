import { describe, expect, it } from "vitest"
import { buildManifest } from "../src/github-app-setup"

// Locks the standard-source manifest. New installs query GitHub on demand. The only event is a
// signed workflow completion signal. Actions write is server-narrowed to workflow discovery,
// dispatch, status, artifacts, and cancellation.
describe("GitHub App manifest", () => {
  const m = buildManifest("https://derive.example.com", "derive.example.com")

  it("subscribes only to signed workflow completion events", () => {
    expect(m.default_events).toEqual(["workflow_run"])
    expect(m.hook_attributes).toEqual({
      url: "https://derive.example.com/v1/github/webhook",
      active: true,
    })
  })

  it("is public so it can install on organizations, not just the owner", () => {
    expect(m.public).toBe(true)
  })

  it("requests only metadata, pull requests, and the bounded Actions capability", () => {
    expect(m.default_permissions).toEqual({
      actions: "write",
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

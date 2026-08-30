import { describe, expect, it } from "vitest"
import { buildManifest } from "../src/github-app-setup"

// Locks the standard-source manifest. New installs query GitHub on demand: no contents,
// issues, webhook events, or sync callback may creep back into this contract. Actions write is
// server-narrowed to workflow discovery, dispatch, status, artifacts, and cancellation.
describe("GitHub App manifest", () => {
  const m = buildManifest("https://derive.example.com", "derive.example.com")

  it("subscribes to no webhook events and configures no webhook", () => {
    expect(m.default_events).toEqual([])
    expect("hook_attributes" in m).toBe(false)
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
    expect(m.callback_urls).toEqual(["https://derive.example.com/v1/github/authorize"])
    expect(m.request_oauth_on_install).toBe(false)
    expect(m.redirect_url).toBe("https://derive.example.com/settings/github/app/created")
  })
})

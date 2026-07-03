import { describe, expect, it } from "vitest"
import { buildManifest } from "../src/github-app-setup"

// Locks the exact manifest shape GitHub accepts. We regressed on each of these
// during the live rollout, so each assertion maps to a real failure we hit:
//   - default_events with installation/installation_repositories → "unsupported"
//   - issue_comment event without the issues permission → "Default events are not
//     supported by permissions: issue_comment" (GitHub maps it to Issues, not PRs)
//   - public:false → couldn't install on an organization
//   - setup_url at the settings page → post-install callback never ran
describe("GitHub App manifest", () => {
  const m = buildManifest("https://derive.example.com", "derive.example.com")

  it("subscribes to permission-backed events (push, PRs, and PR comments)", () => {
    expect(m.default_events).toEqual([
      "push",
      "pull_request",
      "issue_comment",
      "pull_request_review_comment",
    ])
  })

  it("is public so it can install on organizations, not just the owner", () => {
    expect(m.public).toBe(true)
  })

  it("requests read contents/issues/metadata and write pull_requests, nothing more", () => {
    expect(m.default_permissions).toEqual({
      contents: "read",
      issues: "read",
      metadata: "read",
      pull_requests: "write",
    })
  })

  it("points setup_url at the install callback and redirect_url at app creation", () => {
    expect(m.setup_url).toBe("https://derive.example.com/v1/sync/github/callback")
    expect(m.redirect_url).toBe("https://derive.example.com/settings/github/app/created")
    expect(m.hook_attributes.url).toBe("https://derive.example.com/v1/sync/github/webhook")
  })
})

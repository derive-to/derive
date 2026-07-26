import { expect, it } from "vitest"
import { redactPath } from "../src/lib/observability"

// Invite tokens ride URL paths and the DB stores only their hash — the access
// log must not undo that by recording the raw path. Pins the redaction for
// every token prefix in circulation (dki_ workspace, dka_ artifact, dk_agt_).
it("token-shaped path segments never reach the log", () => {
  const t = "a".repeat(64)
  expect(redactPath(`/v1/artifact-invites/dka_${t}`)).toBe("/v1/artifact-invites/dka_[redacted]")
  expect(redactPath(`/v1/artifact-invites/dka_${t}/accept`)).toBe(
    "/v1/artifact-invites/dka_[redacted]/accept",
  )
  expect(redactPath(`/v1/invites/dki_${t}/accept`)).toBe("/v1/invites/dki_[redacted]/accept")
  expect(redactPath(`/x/dk_agt_${t}`)).toBe("/x/dk_agt_[redacted]")
  // Ordinary paths pass through untouched.
  expect(redactPath("/v1/artifacts/abc123/members")).toBe("/v1/artifacts/abc123/members")
})

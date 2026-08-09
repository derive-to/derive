import { describe, expect, it } from "vitest"
import { credentialHintLabel } from "./model-credential-format"

describe("credentialHintLabel", () => {
  it("uses a semantic label for subscription login documents", () => {
    expect(
      credentialHintLabel({
        provider: "codex",
        kind: "login",
        hint: 'Z" }',
        updated_at: "2026-08-09T00:00:00.000Z",
      }),
    ).toBe("subscription")
  })

  it("keeps the masked suffix for ordinary opaque tokens", () => {
    expect(
      credentialHintLabel({
        provider: "codex",
        kind: "api_key",
        hint: "7890",
        updated_at: "2026-08-09T00:00:00.000Z",
      }),
    ).toBe("••••7890")
  })
})

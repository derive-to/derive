import { describe, expect, it } from "vitest"
import {
  CAPABILITIES,
  capabilityReport,
  configWarnings,
  genEnvExample,
  statusOf,
} from "../src/config-manifest"

const email = CAPABILITIES.find((c) => c.id === "email")
if (!email) throw new Error("email capability missing")

describe("statusOf", () => {
  it("is 'on' only when every required var is set", () => {
    expect(statusOf(email, { RESEND_API_KEY: "re_x", EMAIL_FROM: "a@b.c" })).toBe("on")
  })
  it("is 'off' when none are set (blank counts as unset)", () => {
    expect(statusOf(email, {})).toBe("off")
    expect(statusOf(email, { RESEND_API_KEY: "   " })).toBe("off")
  })
  it("is 'partial' when some but not all are set", () => {
    expect(statusOf(email, { RESEND_API_KEY: "re_x" })).toBe("partial")
  })
})

describe("configWarnings", () => {
  it("warns for a half-configured feature and names what's missing", () => {
    const warnings = configWarnings({ GOOGLE_CLIENT_ID: "id" })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("Google sign-in")
    expect(warnings[0]).toContain("GOOGLE_CLIENT_SECRET")
  })
  it("stays silent when features are fully on or fully off", () => {
    expect(configWarnings({})).toEqual([])
    expect(
      configWarnings({ SLACK_CLIENT_ID: "a", SLACK_CLIENT_SECRET: "b", SLACK_SIGNING_SECRET: "c" }),
    ).toEqual([])
  })
})

describe("capabilityReport", () => {
  it("reports status + the still-missing vars per capability", () => {
    const oidc = capabilityReport({ OIDC_ISSUER: "https://x" }).find((r) => r.id === "oidc")
    expect(oidc?.status).toBe("partial")
    expect(oidc?.missing).toEqual(["OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"])
  })
})

describe("genEnvExample", () => {
  // The manifest is the single source; .env.example is generated. Regenerate with
  // `pnpm --filter @derive/api gen:env` after changing CONFIG_VARS.
  it("is the source of the committed .env.example", async () => {
    await expect(genEnvExample()).toMatchFileSnapshot("../../../.env.example")
  })
})

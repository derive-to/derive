import { describe, expect, it } from "vitest"
import { srcCookieString } from "./src-stamp"

// The cookie this builds is read back by the API's parseSrcCookie
// (apps/api/src/lib/attribution.ts) at signup — the format is owned there.
describe("srcCookieString", () => {
  it("builds the d_src pair with kind, artifact, and path, 30-day Lax", () => {
    const s = srcCookieString("badge", "ab12cd34", "/artifacts/doc-ab12cd34")
    expect(s.startsWith("d_src=")).toBe(true)
    expect(s).toContain("path=/")
    expect(s).toContain("max-age=2592000")
    expect(s).toContain("SameSite=Lax")
    const value = decodeURIComponent((s.split(";")[0] ?? "").slice("d_src=".length))
    expect(JSON.parse(value)).toEqual({ k: "badge", a: "ab12cd34", p: "/artifacts/doc-ab12cd34" })
  })

  it("omits the artifact key when there is none and clamps a long path", () => {
    const s = srcCookieString("make_your_own", null, `/${"x".repeat(400)}`)
    const value = decodeURIComponent((s.split(";")[0] ?? "").slice("d_src=".length))
    const parsed = JSON.parse(value)
    expect(parsed.a).toBeUndefined()
    expect(parsed.k).toBe("make_your_own")
    expect((parsed.p as string).length).toBeLessThanOrEqual(200)
  })
})

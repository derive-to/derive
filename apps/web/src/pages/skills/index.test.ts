import { describe, expect, it } from "vitest"
import { skillDisplayName } from "./index"

describe("Skills catalog", () => {
  it("presents machine skill names as readable titles", () => {
    expect(skillDisplayName("sift-demo-artifact", "sift-demo-artifact")).toBe("Sift demo artifact")
    expect(skillDisplayName(null, "weekly-brief")).toBe("Weekly brief")
  })

  it("preserves a distinct authored artifact title", () => {
    expect(skillDisplayName("Sift Demo Builder", "sift-demo-artifact")).toBe("Sift Demo Builder")
  })
})

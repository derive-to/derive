import { describe, expect, it } from "vitest"
import { artifactIdFromInput } from "./derive-source"

describe("artifactIdFromInput", () => {
  it("accepts short ids and readable Derive links", () => {
    expect(artifactIdFromInput("abc12345")).toBe("abc12345")
    expect(artifactIdFromInput("https://derive.to/artifacts/a-plan-abc12345@v4")).toBe("abc12345")
  })

  it("rejects unrelated input", () => {
    expect(artifactIdFromInput("not a derive artifact")).toBeNull()
    expect(artifactIdFromInput("")).toBeNull()
  })
})

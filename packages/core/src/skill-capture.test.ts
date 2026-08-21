import { describe, expect, it } from "vitest"
import { saveAsSkillInstruction } from "./skill-capture"

describe("saveAsSkillInstruction", () => {
  it("builds the base capture prompt without optional context", () => {
    const prompt = saveAsSkillInstruction("abc123")

    expect(prompt).toContain("Derive artifact abc123")
    expect(prompt).toContain('catch_up short_id:"abc123"')
    expect(prompt).not.toContain("comment thread")
    expect(prompt).not.toContain("From the requester:")
  })

  it("includes a thread and trims a requester note", () => {
    const prompt = saveAsSkillInstruction("abc123", {
      threadId: "thread-7",
      note: "  Preserve the concrete example.  ",
    })

    expect(prompt).toContain("comment thread thread-7")
    expect(prompt).toContain("From the requester: Preserve the concrete example.")
  })

  it("omits a whitespace-only requester note", () => {
    expect(saveAsSkillInstruction("abc123", { note: "   " })).not.toContain("From the requester:")
  })
})

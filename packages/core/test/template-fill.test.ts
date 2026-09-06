import { describe, expect, it } from "vitest"
import { fillInstruction } from "../src/template-fill"
import { TEMPLATE_PROTOCOL_INSTRUCTION } from "../src/template-protocol-instruction.gen"

describe("template fill instruction", () => {
  it("uses the canonical fact inventory and protocol-preservation contract", () => {
    const instruction = fillInstruction("copy1234", "source12", {
      brandprint: false,
      note: "  Use the payments evidence.  ",
    })

    expect(instruction).toContain(TEMPLATE_PROTOCOL_INSTRUCTION)
    expect(instruction).toContain('data:"*"')
    expect(instruction).toContain("workflow-definition")
    expect(instruction).toContain("Arbitrary facts do not imply a matching skill")
    expect(instruction).toContain("From the requester: Use the payments evidence.")
  })
})

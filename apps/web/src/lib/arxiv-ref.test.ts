import { describe, expect, it } from "vitest"
import { previewArxivRef } from "./arxiv-ref"

// The same table packages/core/src/arxiv.test.ts pins for the server's parser: the
// preview must agree with the decision, or the form would promise what the server refuses.
describe("previewArxivRef", () => {
  const accepted: [string, string][] = [
    ["https://arxiv.org/abs/2401.12345", "2401.12345"],
    ["https://arxiv.org/abs/2401.12345v2", "2401.12345v2"],
    ["http://arxiv.org/pdf/2401.12345v3.pdf", "2401.12345v3"],
    ["https://www.arxiv.org/abs/2401.12345?context=cs", "2401.12345"],
    ["https://arxiv.org/html/2401.12345v1#S3", "2401.12345v1"],
    ["https://arxiv.org/abs/hep-th/9901001", "hep-th/9901001"],
    ["https://arxiv.org/abs/math.GT/0309136v2", "math.GT/0309136v2"],
    ["arxiv.org/abs/2401.12345", "2401.12345"],
    ["arXiv: 2401.12345v2", "2401.12345v2"],
    ["2401.12345", "2401.12345"],
    ["2401.12345v2.", "2401.12345v2"],
    ["<https://arxiv.org/abs/2401.12345>", "2401.12345"],
    ["https://doi.org/10.48550/arXiv.2401.12345", "2401.12345"],
    ["https://huggingface.co/papers/2401.12345", "2401.12345"],
    ["https://ar5iv.labs.arxiv.org/html/2401.12345", "2401.12345"],
  ]
  it.each(accepted)("accepts %s", (input, canonical) => {
    expect(previewArxivRef(input)?.canonical).toBe(canonical)
  })

  const refused = [
    "",
    "javascript:alert(1)",
    "https://arxiv.org.evil.com/abs/2401.12345",
    "https://evil.com/arxiv.org/abs/2401.12345",
    "https://user:pw@arxiv.org/abs/2401.12345",
    "https://arxiv.org/list/cs/new",
    "https://arxiv.org/abs/2401.123456",
    "https://arxiv.org/abs/2401.12345v0",
    "https://arxiv.org/pdf/2401.12345.pdf.exe",
    "see 2401.12345 for details",
    "２４０１.１２３４５",
    "example.com/abs/2401.12345",
  ]
  it.each(refused)("refuses %j", (input) => {
    expect(previewArxivRef(input)).toBeNull()
  })
})

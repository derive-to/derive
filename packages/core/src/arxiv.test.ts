import { describe, expect, it } from "vitest"
import { arxivAbsUrl, arxivUrls, parseArxivRef } from "./arxiv"

describe("parseArxivRef", () => {
  const accepted: [string, string, number | null][] = [
    ["https://arxiv.org/abs/2401.12345", "2401.12345", null],
    ["https://arxiv.org/abs/2401.12345v2", "2401.12345", 2],
    ["http://arxiv.org/pdf/2401.12345v3.pdf", "2401.12345", 3],
    ["https://arxiv.org/pdf/2401.12345", "2401.12345", null],
    ["https://www.arxiv.org/abs/2401.12345?context=cs", "2401.12345", null],
    ["https://arxiv.org/html/2401.12345v1#S3", "2401.12345", 1],
    ["https://arxiv.org/e-print/2401.12345", "2401.12345", null],
    ["https://arxiv.org/src/2401.12345v2", "2401.12345", 2],
    ["https://export.arxiv.org/abs/2401.12345", "2401.12345", null],
    ["https://arxiv.org/abs/hep-th/9901001", "hep-th/9901001", null],
    ["https://arxiv.org/abs/math.GT/0309136v2", "math.GT/0309136", 2],
    ["https://arxiv.org/pdf/HEP-TH/9901001v1", "hep-th/9901001", 1],
    ["arxiv.org/abs/2401.12345", "2401.12345", null],
    ["arXiv:2401.12345", "2401.12345", null],
    ["arXiv: 2401.12345v2", "2401.12345", 2],
    ["2401.12345", "2401.12345", null],
    ["2401.1234", "2401.1234", null],
    ["2401.12345v2.", "2401.12345", 2],
    ["<https://arxiv.org/abs/2401.12345>", "2401.12345", null],
    ["  https://arxiv.org/abs/2401.12345,  ", "2401.12345", null],
    ["https://doi.org/10.48550/arXiv.2401.12345", "2401.12345", null],
    ["10.48550/arXiv.2401.12345v2", "2401.12345", 2],
    ["doi:10.48550/arXiv.2401.12345", "2401.12345", null],
    ["https://huggingface.co/papers/2401.12345", "2401.12345", null],
    ["https://ar5iv.labs.arxiv.org/html/2401.12345", "2401.12345", null],
    ["https://alphaxiv.org/abs/2401.12345v1", "2401.12345", 1],
  ]
  it.each(accepted)("accepts %s", (input, id, version) => {
    const ref = parseArxivRef(input)
    expect(ref).not.toBeNull()
    expect(ref?.id).toBe(id)
    expect(ref?.version).toBe(version)
    expect(ref?.canonical).toBe(version === null ? id : `${id}v${version}`)
  })

  const refused = [
    "",
    "   ",
    "javascript:alert(1)",
    "data:text/html,2401.12345",
    "ftp://arxiv.org/abs/2401.12345",
    "https://arxiv.org.evil.com/abs/2401.12345",
    "https://evil.com/arxiv.org/abs/2401.12345",
    "https://user:pw@arxiv.org/abs/2401.12345",
    "https://arxiv.org/list/cs/new",
    "https://arxiv.org/abs/2401.123456",
    "https://arxiv.org/abs/2401.12345v0",
    "https://arxiv.org/abs/2401.12345v2/extra",
    "https://arxiv.org/pdf/2401.12345.pdf.exe",
    "https://arxiv.org/abs/../2401.12345",
    "https://arxiv.org/abs/2401.12345/../../evil",
    "https://arxiv.org/abs/2401%2E12345%2F..",
    "see 2401.12345 for details",
    "２４０１.１２３４５",
    "arXiv:2401.12345 and 2401.12346",
    "example.com/abs/2401.12345",
    "https://github.com/arxiv/2401.12345",
    "12345",
    "hep-th/99010",
  ]
  it.each(refused)("refuses %j", (input) => {
    expect(parseArxivRef(input)).toBeNull()
  })

  it("builds request URLs only on arXiv hosts, from the parsed id", () => {
    const ref = parseArxivRef("https://huggingface.co/papers/2401.12345v2")
    if (!ref) throw new Error("expected a ref")
    expect(arxivUrls(ref)).toEqual({
      source: "https://arxiv.org/src/2401.12345v2",
      metadata: "https://export.arxiv.org/api/query?id_list=2401.12345v2",
      bibtex: "https://arxiv.org/bibtex/2401.12345",
    })
    expect(arxivAbsUrl(ref)).toBe("https://arxiv.org/abs/2401.12345v2")
    expect(arxivAbsUrl("hep-th/9901001")).toBe("https://arxiv.org/abs/hep-th/9901001")
  })
})

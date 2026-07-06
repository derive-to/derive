import { describe, expect, it } from "vitest"
import { answerMdToHtml } from "./answer-md"

describe("answerMdToHtml", () => {
  it("renders GFM tables and fenced code (what the comment renderer can't)", () => {
    const md = "| Provider | Orgs |\n|---|---:|\n| Stripe | 2,739 |\n\n```sql\nselect 1\n```"
    const html = answerMdToHtml(md)
    expect(html).toContain("<table>")
    expect(html).toContain('<td align="right">2,739</td>')
    expect(html).toContain("<pre>")
    expect(html).toContain("select 1")
  })

  it("strips scripts, event handlers, and inline style — model output is untrusted", () => {
    const html = answerMdToHtml(
      'x\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<p style="position:fixed">y</p>',
    )
    expect(html).not.toContain("<script")
    expect(html).not.toContain("onerror")
    expect(html).not.toContain("style=")
  })
})

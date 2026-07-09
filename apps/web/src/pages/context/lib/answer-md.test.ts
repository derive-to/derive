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

  it("renders GFM task lists (checkbox inputs survive the whitelist)", () => {
    const html = answerMdToHtml("- [x] verified against warehouse\n- [ ] pending sign-off")
    expect(html).toContain('type="checkbox"')
    expect(html).toContain("checked")
    // …but only the task-list shape: other input types stay stripped attributes-wise.
    expect(answerMdToHtml('<input type="text" onfocus="alert(1)">')).not.toContain("onfocus")
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

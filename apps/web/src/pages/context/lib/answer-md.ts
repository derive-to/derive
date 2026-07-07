import { marked } from "marked"
// xss is CJS; named ESM imports fail under interop (same note as core/md.ts).
import xssPkg from "xss"

const { FilterXSS, whiteList } = xssPkg as unknown as typeof import("xss")

// Answers are full GFM (the models write tables, fences, headings), which the
// comment renderer (mdToHtml — deliberately inline-only) can't carry. Same
// pipeline as core/md.ts: marked → xss whitelist. Mirrored rather than imported
// because core's md module drags the sandbox doc-shell + selection script along,
// none of which belongs in the app bundle.
const sanitizer = new FilterXSS({
  whiteList: {
    ...whiteList,
    a: ["href", "target", "rel", "title"],
    code: ["class"],
    pre: ["class"],
    th: ["align"],
    td: ["align"],
    del: [],
    sup: [],
    sub: [],
    // GFM task lists render as <input type="checkbox" checked disabled> — same
    // entry core/md.ts carries. Found by the Review Companion context reviewing
    // the PR that introduced this file.
    input: ["type", "checked", "disabled"],
  },
})

/** Render an answer's markdown to sanitized HTML. Sync (no async marked extensions). */
export function answerMdToHtml(md: string): string {
  return sanitizer.process(marked.parse(md, { gfm: true, async: false }))
}

import { marked } from "marked"
// xss is CJS; named ESM imports fail under interop (same note as core/md.ts).
import xssPkg from "xss"
import { cn } from "@/lib/utils"

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

/**
 * GFM chrome for rendered answers, via arbitrary variants (tokens only — the design-token check
 * applies). Tables and fences are the two block forms models actually produce that need styling
 * beyond cmt-body's inline set.
 *
 * Lives BESIDE the renderer, and is exported, because the markup and the styling for it are one
 * decision: the chat thread adopted answerMdToHtml and rendered correct <ul>/<h2> markup into a
 * comment bubble that styles neither, so the answer came out as an unmarked list under a heading
 * the same size as the body. Two surfaces render answers; one place says how they look.
 */
export const ANSWER_PROSE = cn(
  "text-sm [word-break:break-word] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
  "[&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-medium",
  "[&_table]:my-2 [&_table]:w-full [&_table]:text-xs",
  "[&_th]:border-b [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium",
  "[&_td]:border-b [&_td]:border-border/50 [&_td]:px-2 [&_td]:py-1.5 [&_td]:tabular-nums",
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-secondary [&_pre]:p-2.5 [&_pre]:font-mono [&_pre]:text-xs",
  "[&_code]:font-mono [&_code]:text-xs [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
  // LINKS HAVE TO LOOK LIKE LINKS. An answer's citations were real anchors that rendered as
  // plain prose, so the one part of an answer worth clicking was the part nothing invited you
  // to click. Same treatment the comment renderer already uses (.cmt-body a in globals.css):
  // the accent colour plus an offset underline, so it reads as a link on both the muted answer
  // bubble and a light background, and matches what a reader has already learned elsewhere.
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_a]:decoration-primary/40",
  "[&_a:hover]:decoration-primary [&_a]:transition-colors",
)

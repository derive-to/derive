import {
  type MarkdownInlineWrapper,
  type MarkdownTextParts,
  type MarkdownTextSegment,
  type MarkdownToken,
  projectMarkdownText,
} from "@aniraga/open-artifact-protocol/source"
import { marked } from "marked"

export type { MarkdownInlineWrapper, MarkdownTextParts, MarkdownTextSegment }

/** Use the renderer's parser with the shared exact-source mapping rules. */
export const markdownTextParts = (source: string): MarkdownTextParts =>
  projectMarkdownText(source, marked.lexer(source, { gfm: true }) as unknown as MarkdownToken[])

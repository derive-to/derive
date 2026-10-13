// Shared source parsing lives in open-artifact. This host keeps its bounded hot-path cache.
import { parseHtmlTags } from "@aniraga/open-artifact-protocol/source"
import { lastOf } from "./memo"

export {
  attrValue,
  attrValues,
  classTokens,
  elementEnd,
  type HtmlTag,
  hasAttr,
  RAW_TEXT_ELEMENTS,
  RCDATA_ELEMENTS,
} from "@aniraga/open-artifact-protocol/source"

/** Every real tag, in source order. Callers treat cached tokens as read-only. */
export const tags = lastOf(3, 32_768, parseHtmlTags)

export const DECK_SLIDE_SELECTOR = "[data-derive-slide], .slide"
export const DECK_LAST_SLIDE_ATTRIBUTE = "data-derive-export-last-slide"

export const DECK_PRINT_CSS =
  "@page{size:13.333333in 7.5in;margin:0}html,body{width:1280px!important;margin:0!important;padding:0!important;overflow:visible!important}.stage{position:static!important;transform:none!important;width:1280px!important;height:auto!important;overflow:visible!important}.slide,[data-derive-slide]{position:relative!important;inset:auto!important;display:flex!important;opacity:1!important;visibility:visible!important;transform:none!important;width:1280px!important;height:720px!important;page-break-after:always!important;break-after:page!important;pointer-events:none!important}[data-derive-export-last-slide]{page-break-after:auto!important;break-after:auto!important}.zone,.rail,.count{display:none!important}"

interface DeckPrintMarkerInput {
  selector: string
  attribute: string
}

/**
 * Runs inside the rendered artifact, not the API runtime. The last selected slide is
 * marked explicitly because it is often followed by deck chrome and therefore is not
 * necessarily `:last-child`. Keeping this callback closure-free lets both Playwright
 * (Node/self-host) and Puppeteer (Cloudflare Browser Rendering) serialize the same code.
 */
export const markFinalDeckSlideForPrint = ({
  selector,
  attribute,
}: DeckPrintMarkerInput): number => {
  const pageGlobal = globalThis as unknown as {
    document: {
      querySelectorAll(query: string): ArrayLike<{
        removeAttribute(name: string): void
        setAttribute(name: string, value: string): void
      }>
    }
  }
  const slides = Array.from(pageGlobal.document.querySelectorAll(selector))
  for (const slide of slides) slide.removeAttribute(attribute)
  const last = slides[slides.length - 1]
  if (last) last.setAttribute(attribute, "")
  return slides.length
}

type EvaluateMarker = (
  callback: typeof markFinalDeckSlideForPrint,
  input: DeckPrintMarkerInput,
) => Promise<number>

/** One shared setup contract prevents the Node and Cloudflare PDF paths from drifting. */
export const prepareDeckPrint = async (
  evaluate: EvaluateMarker,
  addStyle: (css: string) => Promise<unknown>,
): Promise<number> => {
  const slideCount = await evaluate(markFinalDeckSlideForPrint, {
    selector: DECK_SLIDE_SELECTOR,
    attribute: DECK_LAST_SLIDE_ATTRIBUTE,
  })
  await addStyle(DECK_PRINT_CSS)
  return slideCount
}

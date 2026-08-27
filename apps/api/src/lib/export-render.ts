export const EXPORT_SETTLE_CSS =
  "*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}[data-derive-export-transient],[data-derive-chrome],[role=tooltip]{display:none!important}[data-derive-export-region]{break-inside:avoid!important;page-break-inside:avoid!important}"

export const DECK_CAPTURE_CSS =
  "html,body{margin:0!important;width:1280px!important;height:720px!important;overflow:hidden!important}.stage{position:fixed!important;inset:0!important;transform:none!important;width:1280px!important;height:720px!important;border-radius:0!important}.zone,.rail,.count{display:none!important}"

const DECK_CAPTURE_SELECTOR = "[data-derive-slide], .slide"
const EXPORT_READY_TIMEOUT_MS = 3_000

interface SettleInput {
  readyTimeoutMs: number
}

/** Runs inside the rendered artifact. Closure-free so both Playwright and Cloudflare
 * Puppeteer serialize the exact same readiness contract. */
export const waitForExportReady = async ({ readyTimeoutMs }: SettleInput): Promise<void> => {
  const pageGlobal = globalThis as unknown as {
    document: {
      fonts?: { ready: Promise<unknown> }
      images: ArrayLike<{ complete: boolean; decode(): Promise<void> }>
      documentElement: { dataset: Record<string, string> }
    }
  }
  await pageGlobal.document.fonts?.ready
  await Promise.all(
    Array.from(pageGlobal.document.images).map((image) =>
      image.complete ? Promise.resolve() : image.decode().catch(() => undefined),
    ),
  )
  if (pageGlobal.document.documentElement.dataset.deriveExportReady === "true") return
  await new Promise<void>((resolve) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (
        pageGlobal.document.documentElement.dataset.deriveExportReady === "true" ||
        Date.now() - started >= readyTimeoutMs
      ) {
        clearInterval(timer)
        resolve()
      }
    }, 50)
  })
}

type EvaluateSettle = (callback: typeof waitForExportReady, input: SettleInput) => Promise<unknown>

/** One shared setup contract prevents Node and Cloudflare export capture from drifting. */
export const settleExportPage = async (
  evaluate: EvaluateSettle,
  addStyle: (css: string) => Promise<unknown>,
): Promise<void> => {
  await addStyle(EXPORT_SETTLE_CSS)
  await evaluate(waitForExportReady, { readyTimeoutMs: EXPORT_READY_TIMEOUT_MS })
}

interface DeckSelectorInput {
  selector: string
}

interface DeckSlideInput extends DeckSelectorInput {
  at: number
}

export const countDeckSlides = ({ selector }: DeckSelectorInput): number => {
  const pageGlobal = globalThis as unknown as {
    document: { querySelectorAll(query: string): ArrayLike<unknown> }
  }
  return pageGlobal.document.querySelectorAll(selector).length
}

export const showDeckSlide = ({ selector, at }: DeckSlideInput): void => {
  const pageGlobal = globalThis as unknown as {
    document: {
      querySelectorAll(query: string): ArrayLike<{
        style: { setProperty(name: string, value: string, priority: string): void }
      }>
    }
  }
  for (const [index, slide] of Array.from(
    pageGlobal.document.querySelectorAll(selector),
  ).entries()) {
    slide.style.setProperty("opacity", index === at ? "1" : "0", "important")
    slide.style.setProperty("visibility", index === at ? "visible" : "hidden", "important")
    slide.style.setProperty("transform", "none", "important")
  }
}

type EvaluateCount = (callback: typeof countDeckSlides, input: DeckSelectorInput) => Promise<number>
type EvaluateSlide = (callback: typeof showDeckSlide, input: DeckSlideInput) => Promise<unknown>

export const prepareDeckCapture = async (
  evaluate: EvaluateCount,
  addStyle: (css: string) => Promise<unknown>,
): Promise<number> => {
  await addStyle(DECK_CAPTURE_CSS)
  return evaluate(countDeckSlides, { selector: DECK_CAPTURE_SELECTOR })
}

export const selectDeckSlide = (evaluate: EvaluateSlide, at: number): Promise<unknown> =>
  evaluate(showDeckSlide, { selector: DECK_CAPTURE_SELECTOR, at })

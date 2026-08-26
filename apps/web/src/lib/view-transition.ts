type ViewTransitionDocument = Document & {
  __deriveHandlesSkippedViewTransitions?: true
}

const isExpectedCancellation = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError"

/**
 * Chromium rejects all three ViewTransition lifecycle promises when a newer
 * navigation supersedes an in-flight transition. TanStack intentionally does not
 * retain those promises, so the expected cancellation otherwise reaches the page
 * as three unhandled AbortErrors. Observe the native promises without hiding an
 * unexpected transition failure.
 */
export const installViewTransitionErrorHandling = (): void => {
  if (typeof document === "undefined" || typeof document.startViewTransition !== "function") return
  const doc = document as ViewTransitionDocument
  if (doc.__deriveHandlesSkippedViewTransitions) return
  doc.__deriveHandlesSkippedViewTransitions = true

  const original = document.startViewTransition.bind(document)
  document.startViewTransition = ((update: Parameters<typeof original>[0]) => {
    const transition = original(update)
    for (const outcome of [transition.ready, transition.updateCallbackDone, transition.finished]) {
      void outcome.catch((error: unknown) => {
        if (!isExpectedCancellation(error)) throw error
      })
    }
    return transition
  }) as typeof document.startViewTransition
}

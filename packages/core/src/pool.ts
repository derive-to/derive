// Bounded-concurrency helpers: run an async fn over many items with at most `limit`
// in flight. Used to parallelize the GitHub blob fetches that dominate sync wall-clock
// (and, later, R2 puts) without unleashing unbounded concurrency at GitHub's secondary
// rate limit.

/** Run `fn` over `items`, at most `limit` in flight, collecting results in order.
 *  Rejects on the first error — use when a failure must surface to the caller. */
export const mapPool = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i] as T, i)
    }
  }
  const workers = Math.min(Math.max(1, limit), items.length)
  await Promise.all(Array.from({ length: workers }, worker))
  return results
}

/** Like `mapPool` but SWALLOWS rejections (resolves to void). For best-effort work
 *  such as warming a cache: one failed item must not abort the rest, and the real
 *  error still surfaces later on the lazy read path that re-attempts that item. */
export const mapPoolSettled = async <T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<unknown>,
): Promise<void> => {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      try {
        await fn(items[i] as T)
      } catch {
        // leave it uncached; the sequential read re-fetches and surfaces any real error
      }
    }
  }
  const workers = Math.min(Math.max(1, limit), items.length)
  await Promise.all(Array.from({ length: workers }, worker))
}

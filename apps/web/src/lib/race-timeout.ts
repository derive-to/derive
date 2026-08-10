import { reportVital } from "./vitals"

/**
 * Resolve `promise`, or `fallback` once `ms` elapses — whichever first.
 * Use for best-effort boot work (persisted-cache restore) that must not wedge the app
 * if the underlying I/O never settles (wedged IndexedDB, etc.).
 *
 * When `vitalName` is set, a timeout beacons through the vitals sink so the hang is
 * observable in field telemetry / dev consoles.
 */
export const raceTimeout = async <T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
  vitalName?: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => {
          if (vitalName) reportVital(vitalName, ms, "poor")
          resolve({ timedOut: true })
        }, ms)
      }),
    ])
    if (result.timedOut) {
      // Absorb a late settle so a reject after timeout is not an unhandled rejection.
      void promise.then(
        () => {},
        () => {},
      )
      return fallback
    }
    return result.value
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

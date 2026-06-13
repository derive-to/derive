import { type Metric, onCLS, onINP, onLCP, onTTFB } from "web-vitals"

// Where to beacon field metrics. Optional: unset → no beacon (e.g. local dev),
// set in prod to collect real LCP / INP / CLS / TTFB from users.
const BEACON_URL = import.meta.env.VITE_VITALS_URL as string | undefined

// Report Core Web Vitals. In dev we log each metric to the console (with its
// rating) for before/after tuning; when VITE_VITALS_URL is set we also beacon it
// — sendBeacon survives the page unload that finalizes CLS/INP/LCP, so the
// numbers are real field data, not synthetic. Both sinks are no-ops off-window.
export function reportWebVitals() {
  if (typeof window === "undefined") return
  const sink = (m: Metric) => {
    if (import.meta.env.DEV) {
      console.info(`[web-vitals] ${m.name} ${Math.round(m.value)} (${m.rating})`)
    }
    if (BEACON_URL) {
      const body = JSON.stringify({
        name: m.name,
        value: m.value,
        rating: m.rating,
        id: m.id,
        path: location.pathname,
      })
      navigator.sendBeacon?.(BEACON_URL, body)
    }
  }
  onLCP(sink)
  onINP(sink)
  onCLS(sink)
  onTTFB(sink)
}

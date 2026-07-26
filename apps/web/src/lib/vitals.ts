import { type Metric, onCLS, onINP, onLCP, onTTFB } from "web-vitals"
import { API_BASE } from "@/api"

// Where to beacon field metrics. Defaults to the API's own collector
// (`/v1/vitals`, same-origin in the single-container deploy, the API origin in
// the hosted split), so vitals are measured out of the box; point VITE_VITALS_URL
// at a different sink to override. Skipped in dev (we only console-log there).
const BEACON_URL =
  (import.meta.env.VITE_VITALS_URL as string | undefined) ?? `${API_BASE}/v1/vitals`

// Report Core Web Vitals. In dev we log each metric to the console (with its
// rating) for before/after tuning; in prod we also beacon it to the collector —
// sendBeacon survives the page unload that finalizes CLS/INP/LCP, so the numbers
// are real field data, not synthetic. Both sinks are no-ops off-window.
export function reportWebVitals() {
  if (typeof window === "undefined") return
  const sink = (m: Metric) => {
    if (import.meta.env.DEV) {
      console.info(`[web-vitals] ${m.name} ${Math.round(m.value)} (${m.rating})`)
    } else {
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

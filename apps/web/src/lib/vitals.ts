import { onCLS, onINP, onLCP, onTTFB } from "web-vitals"

// Report Core Web Vitals to the console (one line per metric, with its rating)
// so before/after numbers are visible in the devtools while we tune the perf
// tiers. Cheap enough to always run; point the sink at an endpoint when we want
// field data instead of local readings.
export function reportWebVitals() {
  if (typeof window === "undefined") return
  const log = (m: { name: string; value: number; rating: string }) =>
    console.info(`[web-vitals] ${m.name} ${Math.round(m.value)} (${m.rating})`)
  onLCP(log)
  onINP(log)
  onCLS(log)
  onTTFB(log)
}

import { queryOptions } from "@tanstack/react-query"
import { API_BASE } from "@/api"

/** Where the API serves dashboards (derive-dashboards, on Postgres instances). */
export const DASHBOARDS_BASE = `${API_BASE}/v1/dashboards`

/** Whether this instance serves dashboards. Seeded by the bootstrap (`dashboards`); asked
 *  directly only when the bootstrap has not answered. Kept free of the library itself: the
 *  rail reads it on every page, and the library loads only with the Dashboards route. */
export const dashboardsAvailableQuery = () =>
  queryOptions({
    queryKey: ["dashboards", "available"] as const,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => (await fetch(`${DASHBOARDS_BASE}/meta`, { credentials: "include" })).ok,
  })

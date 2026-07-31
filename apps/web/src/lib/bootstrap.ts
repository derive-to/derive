import { type QueryClient, queryOptions, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/api"
import { useAuth } from "@/ctx"
import {
  collectionsQuery,
  notificationsQuery,
  summaryQuery,
  workspaceSettingsQuery,
} from "./queries"

// The signed-in boot, as ONE request. Four queries used to fire together on every cold
// boot — tags summary, collections, workspace settings, notifications — each paying its
// own authenticated Worker invocation and its own Postgres round trips. bootstrapQuery
// fetches GET /v1/bootstrap once and seeds those four caches verbatim (the server builds
// each field with the exact mapper its standalone endpoint uses, so a seed is
// indistinguishable from the endpoint having answered). The four consumers then find
// fresh data and never fetch.
//
// The contract that keeps this safe:
// - Consumers gate on useBootGate(), which opens as soon as the bootstrap SETTLES —
//   success or failure. On failure every consumer simply runs its own query, which is
//   exactly the pre-bootstrap behavior; retry: false keeps that fallback fast instead
//   of holding boot hostage to a retry ladder.
// - Later invalidations (an SSE notification, a collection edit) hit the individual
//   keys and refetch the individual endpoints — the bootstrap is a BOOT read, never
//   re-fired by cache churn.
// - Never persisted: it exists to seed the persisted per-endpoint caches; a second
//   copy in IndexedDB would only lengthen the restore every boot pays.
export const bootstrapQuery = (client: QueryClient) =>
  queryOptions({
    queryKey: ["bootstrap"] as const,
    staleTime: 30_000,
    retry: false,
    meta: { persist: false },
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const b = await api.bootstrap({ signal })
      client.setQueryData(summaryQuery().queryKey, b.summary)
      client.setQueryData(collectionsQuery().queryKey, b.collections)
      client.setQueryData(workspaceSettingsQuery().queryKey, b.settings)
      client.setQueryData(notificationsQuery().queryKey, {
        notifications: b.notifications,
        unread: b.unread,
      })
      return true
    },
  })

/** True once the boot read has settled (either way) for a signed-in user — the gate the
 *  four seeded queries' `enabled` conditions AND with, so they neither race the batch
 *  nor stall behind a failed one. Anonymous sessions return false and the consumers'
 *  own `enabled: !!me` guards keep everything quiet, as before. */
export function useBootGate(): boolean {
  const { me } = useAuth()
  const qc = useQueryClient()
  const bs = useQuery({ ...bootstrapQuery(qc), enabled: !!me })
  return !!me && (bs.isFetched || bs.isError)
}

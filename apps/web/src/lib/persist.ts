import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister"
import { defaultShouldDehydrateQuery, type Query, type QueryClient } from "@tanstack/react-query"
import {
  persistQueryClientRestore,
  persistQueryClientSubscribe,
} from "@tanstack/react-query-persist-client"
import { del, get, set } from "idb-keyval"
import { CACHE_MAX_AGE, queryClient, shouldPersistQuery } from "./query-client"

// Persist the query cache to IndexedDB so a refresh restores the last-known data and paints
// instantly — the same warm cache an in-app navigation already runs against. This erases the
// cold-boot asymmetry that made a reload feel different from navigating: the SPA served cache
// instantly on a nav but started empty on refresh. SOTA stale-while-revalidate — show what you
// had at once, revalidate underneath, and skeleton only when there is genuinely nothing cached.

// One IndexedDB entry holds the whole dehydrated cache; the persister serializes to a string,
// so idb-keyval just stores/reads that string (coalescing a missing key → null).
const queryPersister = createAsyncStoragePersister({
  storage: {
    getItem: (key) => get<string>(key).then((v) => v ?? null),
    setItem: (key, value) => set(key, value),
    removeItem: (key) => del(key),
  },
  key: "derive-query-cache",
  // Coalesce writes so a burst of cache updates costs one IndexedDB round-trip, not many.
  throttleTime: 1000,
})

const persistOptions = {
  queryClient,
  persister: queryPersister,
  // How long a persisted cache may be restored before it's discarded as too old. Shared with
  // the client's gcTime so an inactive query survives in memory as long as its persisted copy.
  maxAge: CACHE_MAX_AGE,
  // A fresh build busts the cache, so a deploy that changes a response shape never restores
  // stale-shaped data into a component that no longer expects it. Vite replaces the token at
  // build; the typeof guard keeps it defined in envs without the define (vitest, plain Node).
  buster: typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__ : "dev",
  dehydrateOptions: {
    // Persist successful queries EXCEPT those that opted out with `meta.persist: false` — the
    // session (auth re-resolves fresh) and anything keyed by a secret/capability token. The
    // opt-out is declared at each query, not listed here (see AppQueryMeta in query-client.ts).
    shouldDehydrateQuery: (q: Query) =>
      shouldPersistQuery(q.meta) && defaultShouldDehydrateQuery(q),
  },
}

// Workspace switch/create/delete reload into a different content context, so the persisted
// cache must not be restored — nearly every query is workspace-scoped, and any restored entry
// (worse, a staleTime-Infinity one like workspaceQuery) would keep serving the OLD workspace's
// data after the switch. Clearing the cache in-page before the reload is racy: the subscriber's
// throttled write can land after the delete and resurrect the pre-switch snapshot. So the
// switch path sets this flag instead, and the NEXT boot — before the persister has subscribed,
// when nothing can race the delete — drops the store and starts cold.
const RESET_KEY = "derive-cache-reset"

/** Ask the next page boot to discard the persisted cache instead of restoring it. Call
 *  right before a reload that changes the workspace context. */
export function dropPersistedCacheOnNextBoot(): void {
  try {
    sessionStorage.setItem(RESET_KEY, "1")
  } catch {
    /* private mode — the boot restores as usual; staleness is bounded by CACHE_MAX_AGE */
  }
}

const consumeResetFlag = (): boolean => {
  try {
    if (sessionStorage.getItem(RESET_KEY) !== "1") return false
    sessionStorage.removeItem(RESET_KEY)
    return true
  } catch {
    return false
  }
}

// Restore the persisted cache ONCE, up front, then keep persisting future changes. The root
// route's beforeLoad awaits `cacheRestored`, so no route loader (ensureQueryData) fetches cold
// before the disk cache has hydrated — that ordering is what lets a reload paint from cache
// like a nav instead of gating on a cold loader fetch. A no-op-fast path when nothing's stored.
// Guarded to the browser: the SPA shell prerenders in Node, where IndexedDB doesn't exist.
// The library silently discards an expired/busted/corrupt cache, but a blocked IndexedDB
// (private mode, quota, a locked DB) can still reject — so swallow it and boot cold rather
// than fail the root beforeLoad and take down the whole app.
export const cacheRestored: Promise<void> =
  typeof indexedDB === "undefined"
    ? Promise.resolve()
    : (consumeResetFlag()
        ? Promise.resolve(queryPersister.removeClient())
        : persistQueryClientRestore(persistOptions)
      )
        .then(() => {
          persistQueryClientSubscribe(persistOptions)
        })
        .catch(() => {})

// Logout is a client nav, not a hard reload, so nothing clears the caches on its own — wipe
// BOTH the in-memory client and the IndexedDB copy so the next person on this browser can't
// read the signed-out user's data.
export async function clearPersistedCache(qc: QueryClient) {
  await queryPersister.removeClient()
  qc.clear()
}

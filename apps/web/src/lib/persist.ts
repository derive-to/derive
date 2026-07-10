import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister"
import { defaultShouldDehydrateQuery, type QueryClient } from "@tanstack/react-query"
import {
  persistQueryClientRestore,
  persistQueryClientSubscribe,
} from "@tanstack/react-query-persist-client"
import { del, get, set } from "idb-keyval"
import { queryClient } from "./query-client"

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
  // How long a persisted cache may be restored before it's discarded as too old — a full day,
  // so restores are instant across a normal work session but never resurrect yesterday's world.
  maxAge: 1000 * 60 * 60 * 24,
  // A fresh build busts the cache, so a deploy that changes a response shape never restores
  // stale-shaped data into a component that no longer expects it.
  buster: __BUILD_ID__,
  dehydrateOptions: {
    // Persist data, but NEVER the session: `me` must re-resolve fresh on every boot so an
    // expired session can't restore as "logged in" (the route guards await a live one).
    shouldDehydrateQuery: (q: { queryKey: readonly unknown[] }) =>
      q.queryKey[0] !== "me" &&
      defaultShouldDehydrateQuery(q as Parameters<typeof defaultShouldDehydrateQuery>[0]),
  },
}

// Restore the persisted cache ONCE, up front, then keep persisting future changes. The root
// route's beforeLoad awaits `cacheRestored`, so no route loader (ensureQueryData) fetches cold
// before the disk cache has hydrated — that ordering is what lets a reload paint from cache
// like a nav instead of gating on a cold loader fetch. A no-op-fast path when nothing's stored.
// Guarded to the browser: the SPA shell prerenders in Node, where IndexedDB doesn't exist.
export const cacheRestored: Promise<void> =
  typeof indexedDB === "undefined"
    ? Promise.resolve()
    : persistQueryClientRestore(persistOptions).then(() => {
        persistQueryClientSubscribe(persistOptions)
      })

// Logout is a client nav, not a hard reload, so nothing clears the caches on its own — wipe
// BOTH the in-memory client and the IndexedDB copy so the next person on this browser can't
// read the signed-out user's data.
export async function clearPersistedCache(qc: QueryClient) {
  await queryPersister.removeClient()
  qc.clear()
}

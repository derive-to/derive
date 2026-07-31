import { useSyncExternalStore } from "react"

/** Why the paywall opened: over the free seat limit, a lapsed plan, or a storage
 *  cap. Drives the UpgradeDialog's headline; the mapping from server codes lives
 *  in query-client.ts (paywallReasonFor), the one place mutation errors funnel. */
export type PaywallReason = "seats" | "lapsed" | "storage"

// A module store, not context: the opener is the global MutationCache (outside
// React), and the single subscriber is the UpgradeDialog. useSyncExternalStore
// keeps it concurrent-safe without adding a state library.
let current: PaywallReason | null = null
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}

export const openPaywall = (reason: PaywallReason): void => {
  current = reason
  emit()
}
export const closePaywall = (): void => {
  current = null
  emit()
}

export const usePaywall = (): PaywallReason | null =>
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current,
  )

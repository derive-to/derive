import { useSyncExternalStore } from "react"

/** Why the paywall opened: over the free seat limit, a lapsed plan, or a storage
 *  cap. Drives the UpgradeDialog's headline; the mapping from server codes lives
 *  in query-client.ts (paywallReasonFor). The global MutationCache there opens
 *  this dialog for EVERY mutation that fails with a billing code, and
 *  useApiMutation's own onError skips the caller's onError on that same check —
 *  so useApiMutation callers get this for free. Only error UI raised OUTSIDE the
 *  primitive's onError needs its own `paywallReasonFor(err)` guard: the review
 *  overlay's hand-rolled `act` (pages/artifact/review/index.tsx) and brandprint
 *  import's per-file catch inside its mutationFn (pages/brandprint/use-brandprint-import.ts). */
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

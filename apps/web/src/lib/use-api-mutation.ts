import { type QueryClient, type QueryKey, useMutation, useQueryClient } from "@tanstack/react-query"
import { useCallback, useState } from "react"
import { toast } from "@/components/ui/sonner"

/**
 * The one governed mutation primitive — every write in the app goes through here so
 * feedback is uniform and can't drift. It is the `use-follows` pattern extracted once
 * instead of hand-copied per site: snapshot → apply optimistic edit → call → roll back
 * + toast on error → invalidate on settle. Three guarantees fall out of that:
 *
 *  1. A rejected write ALWAYS surfaces — the global MutationCache toasts it (see
 *     query-client.ts) unless this mutation sets `errorToast:false` to render inline.
 *  2. An optimistic edit ALWAYS rolls back on failure — you can't forget the `catch`.
 *  3. Pending state is always available for a spinner / disabled button.
 *
 * Built on react-query's useMutation, so `isPending` and cache integration are free.
 * For a list where each row toggles independently, pass `pendingKey` and read
 * `isPendingFor(key)` so one row's in-flight spinner never disables its siblings.
 */
export function useApiMutation<TData = unknown, TVars = void>(config: {
  /** The write itself — an `api.*` call returning a promise. */
  mutationFn: (vars: TVars) => Promise<TData>
  /** Apply the optimistic edit and RETURN a rollback thunk; the primitive runs the
   *  rollback if the mutation rejects. Use `snapshot(qc, key)` for the common case. */
  optimistic?: (vars: TVars, qc: QueryClient) => () => void
  /** Queries to reconcile against the server once settled (on success OR failure). */
  invalidate?: QueryKey[] | ((data: TData, vars: TVars) => QueryKey[])
  /** An opt-in success toast — a string, or a fn of the result (return nothing to
   *  stay silent, e.g. when the UI change is its own confirmation). */
  success?: string | ((data: TData, vars: TVars) => string | undefined)
  /** Opt OUT of the global error toast to render the failure inline from `error`. */
  errorToast?: boolean
  /** A per-call key so `isPendingFor(key)` scopes the spinner to one list row. */
  pendingKey?: (vars: TVars) => string
  /** Extra success side-effect (navigate, close a dialog) once the write lands. */
  onSuccess?: (data: TData, vars: TVars) => void
}) {
  const qc = useQueryClient()
  // Keys with an in-flight mutation — per-call so one row's toggle doesn't disable
  // every sibling. Empty (and unused) unless the caller passes `pendingKey`.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const mark = useCallback((key: string, on: boolean) => {
    setPending((prev) => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  const m = useMutation<TData, Error, TVars, { rollback?: () => void; pendingKey?: string }>({
    mutationFn: config.mutationFn,
    meta: { errorToast: config.errorToast },
    onMutate: (vars) => {
      const pendingKey = config.pendingKey?.(vars)
      if (pendingKey) mark(pendingKey, true)
      const rollback = config.optimistic?.(vars, qc)
      return { rollback, pendingKey }
    },
    onError: (_err, _vars, ctx) => {
      // Undo the optimistic edit. The TOAST is the MutationCache's job (it honors
      // meta.errorToast), so toasting here too would double up.
      ctx?.rollback?.()
    },
    onSuccess: (data, vars) => {
      const msg = typeof config.success === "function" ? config.success(data, vars) : config.success
      if (msg) toast.success(msg)
      config.onSuccess?.(data, vars)
    },
    onSettled: (data, err, vars, ctx) => {
      if (ctx?.pendingKey) mark(ctx.pendingKey, false)
      for (const key of invalidateKeys(config.invalidate, data, err, vars))
        void qc.invalidateQueries({ queryKey: key })
    },
  })

  return {
    mutate: m.mutate,
    mutateAsync: m.mutateAsync,
    isPending: m.isPending,
    /** Is THIS keyed call mid-flight? (per-item, not the hook-global `isPending`). */
    isPendingFor: (key: string) => pending.has(key),
    /** The last error, for sites that set `errorToast:false` and render it inline. */
    error: m.error,
    reset: m.reset,
  }
}

/**
 * Snapshot one query's cached data and return a rollback that restores it verbatim.
 * The building block for `optimistic`: capture BEFORE you `setQueryData`, then let the
 * primitive call the returned thunk if the write fails. Pure over the QueryClient, so
 * it's the unit-tested heart of the optimistic path. Relies on react-query's immutable
 * updates — the pre-edit value is held by reference and a later update never mutates it.
 */
/**
 * Which queries to reconcile once a mutation settles. The ARRAY form runs on success OR
 * failure (reconcile either way). The FUNCTION form needs the result, so it runs only on
 * SUCCESS — gated on the error, NOT on `data`: a void mutation resolves `data` to `undefined`
 * on success too, so a `data === undefined` check would wrongly skip it. Pure + exported so
 * the discriminator is unit-tested rather than buried in the hook's onSettled closure.
 */
export function invalidateKeys<TData, TVars>(
  invalidate: QueryKey[] | ((data: TData, vars: TVars) => QueryKey[]) | undefined,
  data: TData | undefined,
  err: unknown,
  vars: TVars,
): QueryKey[] {
  if (Array.isArray(invalidate)) return invalidate
  if (typeof invalidate === "function") return err ? [] : invalidate(data as TData, vars)
  return []
}

export function snapshot(qc: QueryClient, key: QueryKey): () => void {
  const prev = qc.getQueryData(key)
  // react-query treats setQueryData(key, undefined) as a no-op, so when the key held
  // nothing before the optimistic edit the rollback must REMOVE the entry to truly
  // restore "no data" — otherwise a failed write would leave the optimistic value behind.
  return () => {
    if (prev === undefined) qc.removeQueries({ queryKey: key, exact: true })
    else qc.setQueryData(key, prev)
  }
}

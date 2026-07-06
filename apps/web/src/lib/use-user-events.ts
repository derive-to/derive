import { useEffect, useRef } from "react"
import { api } from "@/api"

// One per-user SSE stream per tab, shared by every subscriber (the notification
// bell, the agent-push listener). The stream opens on the first subscriber and
// closes on the last — subscribers gate themselves on auth + page visibility, so
// a hidden tab still releases the per-user room Durable Object (the contract
// that keeps DO active-duration cost down).

type Handler = (e: MessageEvent) => void

let source: EventSource | null = null
const listeners = new Map<string, Set<Handler>>()
// Event types the current EventSource has a dispatcher bound for. Reset when the
// stream closes so a reopened stream re-binds every live type.
const attached = new Set<string>()

const attach = (type: string) => {
  if (!source || attached.has(type)) return
  attached.add(type)
  source.addEventListener(type, (e) => {
    for (const h of listeners.get(type) ?? []) h(e)
  })
}

const total = () => [...listeners.values()].reduce((n, s) => n + s.size, 0)

const subscribe = (type: string, h: Handler): (() => void) => {
  let set = listeners.get(type)
  if (!set) {
    set = new Set()
    listeners.set(type, set)
  }
  set.add(h)
  if (!source) {
    source = new EventSource(api.notificationsStreamUrl(), { withCredentials: true })
    for (const t of listeners.keys()) attach(t)
  } else {
    attach(type)
  }
  return () => {
    set.delete(h)
    if (set.size === 0) listeners.delete(type)
    if (total() === 0) {
      source?.close()
      source = null
      attached.clear()
    }
  }
}

/** Subscribe to one event type on the shared per-user stream. The latest handler
 *  is kept in a ref, so re-renders never churn the subscription; `enabled` gates
 *  the whole thing (pass `!!me && visible` to honor the hidden-tab contract). */
export function useUserEvent(type: string, handler: Handler, enabled: boolean): void {
  const latest = useRef(handler)
  latest.current = handler
  useEffect(() => {
    if (!enabled) return
    return subscribe(type, (e) => latest.current(e))
  }, [type, enabled])
}

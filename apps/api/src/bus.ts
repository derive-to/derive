import type { Context } from "hono"
import type { DomainEvent } from "./events"

export interface DockEvent {
  // The event name is constrained to the shared DOMAIN_EVENTS union, so a typo
  // (`bus.publish(id, { type: "comment.reslved" })`) is a compile error. The
  // per-event payload stays open via the index signature.
  type: DomainEvent
  [k: string]: unknown
}

/** In-process pub/sub, keyed by artifact id. One process fans out in memory. */
export interface EventBus {
  subscribe(artifactId: string, cb: (e: DockEvent) => void): () => void
  publish(artifactId: string, e: DockEvent): void
}

export function createBus(): EventBus {
  const subs = new Map<string, Set<(e: DockEvent) => void>>()
  return {
    subscribe(artifactId, cb) {
      let set = subs.get(artifactId)
      if (!set) {
        set = new Set()
        subs.set(artifactId, set)
      }
      const s = set
      s.add(cb)
      return () => {
        s.delete(cb)
        if (s.size === 0) subs.delete(artifactId)
      }
    },
    publish(artifactId, e) {
      subs.get(artifactId)?.forEach((cb) => {
        cb(e)
      })
    },
  }
}

/** Ephemeral presence per artifact: name → last-seen ms. Lost on restart. */
export class Presence {
  private viewers = new Map<string, Map<string, number>>()
  constructor(private ttlMs = 45_000) {}

  /** Records a heartbeat and returns the live viewer names. */
  heartbeat(artifactId: string, name: string, now: number): string[] {
    let m = this.viewers.get(artifactId)
    if (!m) {
      m = new Map()
      this.viewers.set(artifactId, m)
    }
    m.set(name, now)
    for (const [n, t] of m) if (now - t > this.ttlMs) m.delete(n)
    return [...m.keys()]
  }
}

/** Presence as a port: in-process is synchronous; a Durable Object / Redis store
 *  resolves asynchronously, so callers await the result either way. */
export interface PresenceStore {
  heartbeat(channel: string, name: string, now: number): string[] | Promise<string[]>
}

/**
 * The realtime backplane: cross-instance event relay + presence, with an optional
 * connection-owning hook. Relay adapters (in-process, Redis) return null from
 * `handleStream` and let the route hold the SSE stream + `subscribe`; a Durable
 * Object adapter owns the stream itself and returns the Response. `publish` stays
 * synchronous (fire-and-forget for remote adapters) so the route call sites don't
 * change. Selected by env; defaults to in-process so self-host stays zero-config.
 */
export interface Backplane {
  publish(channel: string, e: DockEvent): void
  subscribe(channel: string, cb: (e: DockEvent) => void): () => void
  presence: PresenceStore
  handleStream?(c: Context, channel: string): Response | Promise<Response> | null
}

/** Default backplane: in-memory bus + presence, single process. The route owns
 *  the SSE stream (handleStream returns null). */
export function createInProcessBackplane(): Backplane {
  const bus = createBus()
  const presence = new Presence()
  return {
    publish: bus.publish,
    subscribe: bus.subscribe,
    presence,
    handleStream: () => null,
  }
}

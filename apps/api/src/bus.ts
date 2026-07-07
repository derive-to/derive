import type { Context } from "hono"
import type { DomainEvent } from "./events"

export interface DeriveEvent {
  // The event name is constrained to the shared DOMAIN_EVENTS union, so a typo
  // (`bus.publish(id, { type: "comment.reslved" })`) is a compile error. The
  // per-event payload stays open via the index signature.
  type: DomainEvent
  [k: string]: unknown
}

/** In-process pub/sub, keyed by artifact id. One process fans out in memory. */
export interface EventBus {
  subscribe(artifactId: string, cb: (e: DeriveEvent) => void): () => void
  publish(artifactId: string, e: DeriveEvent): void
  /** How many live subscribers a channel has right now. */
  count(artifactId: string): number
}

export function createBus(): EventBus {
  const subs = new Map<string, Set<(e: DeriveEvent) => void>>()
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
    count(artifactId) {
      return subs.get(artifactId)?.size ?? 0
    },
  }
}

/** A live viewer of an artifact: server-derived identity + their effective role.
 *  No `email` — presence is broadcast to every co-viewer (incl. anonymous ones on
 *  a public/link artifact) and relayed over the wildcard-CORS `/events` SSE, so it
 *  must never carry PII. The "who's viewing" UI only needs a display name + role.
 *  Identity is never client-supplied (see the presence route). */
export interface Viewer {
  id: string
  name: string
  role: string | null
}

// Presence heartbeat TTL — a streamless caller (a bare POST /presence with no /events
// open) is counted gone this long after its last beat. Shared with the edge DO.
export const PRESENCE_TTL_MS = 45_000

/** Ephemeral presence per artifact. A viewer is present while they hold ≥1 open SSE
 *  stream — join on connect, leave the instant that stream closes, so a departure
 *  (tab-close or crash) reflects in ~a second, not after the heartbeat TTL. The TTL
 *  is the backstop for a STREAMLESS caller (a bare `POST /presence` with no `/events`
 *  open, e.g. a test). Keyed by viewer id, so multiple tabs collapse to one row.
 *  Lost on restart. */
export class Presence {
  private rooms = new Map<string, Map<string, { v: Viewer; t: number; streams: Set<string> }>>()
  constructor(private ttlMs = PRESENCE_TTL_MS) {}

  private room(artifactId: string) {
    let m = this.rooms.get(artifactId)
    if (!m) {
      m = new Map()
      this.rooms.set(artifactId, m)
    }
    return m
  }
  // A streamed viewer stays until their last stream closes; a streamless one ages
  // out on the TTL. So a live SSE viewer is never pruned mid-session.
  private list(
    m: Map<string, { v: Viewer; t: number; streams: Set<string> }>,
    now: number,
  ): Viewer[] {
    for (const [id, e] of m) if (e.streams.size === 0 && now - e.t > this.ttlMs) m.delete(id)
    return [...m.values()].map((e) => e.v)
  }

  /** A heartbeat keep-alive (and the streamless join path): upsert + refresh. */
  heartbeat(artifactId: string, viewer: Viewer, now: number): Viewer[] {
    const m = this.room(artifactId)
    const e = m.get(viewer.id)
    if (e) {
      e.v = viewer
      e.t = now
    } else {
      m.set(viewer.id, { v: viewer, t: now, streams: new Set() })
    }
    return this.list(m, now)
  }

  /** An SSE stream opened — present until it closes. */
  join(artifactId: string, viewer: Viewer, streamKey: string, now: number): Viewer[] {
    const m = this.room(artifactId)
    const e = m.get(viewer.id)
    if (e) {
      e.v = viewer
      e.t = now
      e.streams.add(streamKey)
    } else {
      m.set(viewer.id, { v: viewer, t: now, streams: new Set([streamKey]) })
    }
    return this.list(m, now)
  }

  /** An SSE stream closed — drop the viewer once it was their last one. */
  leave(artifactId: string, viewerId: string, streamKey: string, now: number): Viewer[] {
    const m = this.rooms.get(artifactId)
    if (!m) return []
    const e = m.get(viewerId)
    if (e) {
      e.streams.delete(streamKey)
      if (e.streams.size === 0) m.delete(viewerId)
    }
    return this.list(m, now)
  }
}

/** Presence as a port: in-process is synchronous; a Durable Object / Redis store
 *  resolves asynchronously, so callers await the result either way. */
export interface PresenceStore {
  heartbeat(channel: string, viewer: Viewer, now: number): Viewer[] | Promise<Viewer[]>
  join(
    channel: string,
    viewer: Viewer,
    streamKey: string,
    now: number,
  ): Viewer[] | Promise<Viewer[]>
  leave(
    channel: string,
    viewerId: string,
    streamKey: string,
    now: number,
  ): Viewer[] | Promise<Viewer[]>
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
  publish(channel: string, e: DeriveEvent): void
  subscribe(channel: string, cb: (e: DeriveEvent) => void): () => void
  presence: PresenceStore
  // `viewer` is present only for the artifact `/events` stream (presence rides its
  // lifecycle); the notification channel (`u:<id>`) has no presence and omits it.
  handleStream?(c: Context, channel: string, viewer?: Viewer): Response | Promise<Response> | null
  /** Publish and report how many live streams received the event — the "did any
   *  open tab catch this" receipt behind publish's `opened_in_tab`. Best-effort:
   *  adapters that can't count resolve 0. */
  publishWithReceipt?(channel: string, e: DeriveEvent): Promise<number>
  /** Block until an event of one of `types` lands on `channel`, or `timeoutMs`
   *  passes — the long-poll primitive behind catch_up's `wait`. The event is only
   *  a wake signal (callers re-read state from the store), so a missed event is
   *  never a correctness problem. `release` lets a caller that subscribed early
   *  (before its state check, to close the check-then-wait gap) let go without
   *  holding the wait open. */
  waitFor?(
    channel: string,
    types: DomainEvent[],
    timeoutMs: number,
    release?: AbortSignal,
  ): Promise<DeriveEvent | null>
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
    publishWithReceipt(channel, e) {
      const delivered = bus.count(channel)
      bus.publish(channel, e)
      return Promise.resolve(delivered)
    },
    waitFor(channel, types, timeoutMs, release) {
      return new Promise((resolve) => {
        let done = false
        const finish = (e: DeriveEvent | null) => {
          if (done) return
          done = true
          clearTimeout(timer)
          unsub()
          resolve(e)
        }
        const unsub = bus.subscribe(channel, (e) => {
          if (types.includes(e.type)) finish(e)
        })
        const timer = setTimeout(() => finish(null), timeoutMs)
        release?.addEventListener("abort", () => finish(null), { once: true })
      })
    },
  }
}

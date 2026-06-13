export interface DockEvent {
  type:
    | "comment.created"
    | "comment.resolved"
    | "comment.reacted"
    | "comment.updated"
    | "version.published"
    | "presence"
    | "notification"
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

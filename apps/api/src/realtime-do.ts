import { AsyncLocalStorage } from "node:async_hooks"
import type {
  DurableObjectNamespace,
  DurableObjectState,
  ExecutionContext,
} from "@cloudflare/workers-types"
import type { Context } from "hono"
import {
  type Backplane,
  type DeriveEvent,
  PRESENCE_TTL_MS,
  type PresenceStore,
  type Viewer,
} from "./bus"
import type { DomainEvent } from "./events"

/**
 * Per-request execution context, so the DO backplane's fire-and-forget publish can
 * ride `waitUntil` — Workers cancels un-awaited async once the response is sent, so
 * a bare `void fetch(...)` to the room DO would be killed before it lands. The Worker
 * entry wraps `app.fetch` in `edgeCtx.run(ctx, …)`.
 */
export const edgeCtx = new AsyncLocalStorage<ExecutionContext>()

/** Ride a fire-and-forget promise on the request's `waitUntil` so Workers doesn't cancel
 *  it once the response is sent; a plain `void` when there's no execution context (Node). */
export const edgeWaitUntil = (p: Promise<unknown>): void => {
  const ctx = edgeCtx.getStore()
  if (ctx) ctx.waitUntil(p)
  else void p
}

const PING_MS = 20_000
const enc = new TextEncoder()
const frame = (event: string, data: string) => enc.encode(`event: ${event}\ndata: ${data}\n\n`)

/**
 * Realtime room: one Durable Object per channel (an artifact id, or `u:<userId>`
 * for the notification bell). It owns the SSE connections for that channel and
 * broadcasts events to them, so fan-out works across Worker isolates — every
 * client for a channel reaches the same DO.
 *
 * Presence is tied to those connections: a viewer is present while they hold ≥1 open
 * `/events` stream. Connect registers them (identity rides a query param, derived
 * server-side upstream); `cancel()` — which fires the instant the SSE client
 * disconnects — drops them and re-broadcasts, so a tab-close or crash reflects in
 * ~a second (the ping doubles as the crash detector). A bare `POST /heartbeat`
 * (a streamless caller with no `/events` open) is the TTL-backstopped fallback.
 */
export class ArtifactRoom {
  private streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  // Each open stream's viewer id, so a closed stream drops the right viewer.
  private streamViewer = new Map<ReadableStreamDefaultController<Uint8Array>, string>()
  // Roster: viewer id → identity + open-stream count. Present while `n > 0`; a
  // streamless heartbeat (n === 0) ages out on the TTL.
  private viewers = new Map<string, { v: Viewer; t: number; n: number }>()
  constructor(private state: DurableObjectState) {}

  private roster(now: number): Viewer[] {
    for (const [id, e] of this.viewers)
      if (e.n === 0 && now - e.t > PRESENCE_TTL_MS) this.viewers.delete(id)
    return [...this.viewers.values()].map((e) => e.v)
  }

  private broadcastPresence(): void {
    const f = frame(
      "presence",
      JSON.stringify({ type: "presence", viewers: this.roster(Date.now()) }),
    )
    for (const c of this.streams)
      try {
        c.enqueue(f)
      } catch {
        this.drop(c)
      }
  }

  // Forget a closed/dead stream; if it was the viewer's last, drop them. Returns
  // whether the roster changed (so the caller can decide to re-broadcast).
  private drop(c: ReadableStreamDefaultController<Uint8Array>): boolean {
    if (!this.streams.delete(c)) return false
    const vid = this.streamViewer.get(c)
    this.streamViewer.delete(c)
    if (vid == null) return false
    const e = this.viewers.get(vid)
    if (e && --e.n <= 0) {
      this.viewers.delete(vid)
      return true
    }
    return false
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)

    // SSE connect: hold an open stream, register the viewer, tell everyone.
    if (req.method === "GET") {
      const viewer = JSON.parse(url.searchParams.get("v") ?? "null") as Viewer | null
      const room = this
      const storage = this.state.storage
      let ctrl: ReadableStreamDefaultController<Uint8Array>
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          ctrl = c
          room.streams.add(c)
          c.enqueue(frame("ready", "{}"))
          if (room.streams.size === 1) void storage.setAlarm(Date.now() + PING_MS)
          if (viewer) {
            room.streamViewer.set(c, viewer.id)
            const e = room.viewers.get(viewer.id)
            if (e) {
              e.v = viewer
              e.t = Date.now()
              e.n++
            } else {
              room.viewers.set(viewer.id, { v: viewer, t: Date.now(), n: 1 })
            }
            room.broadcastPresence()
          }
        },
        cancel() {
          if (room.drop(ctrl)) room.broadcastPresence()
        },
      })
      return new Response(body, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "access-control-allow-origin": "*",
        },
      })
    }

    // Broadcast an event to every open stream on this channel. Reports how many
    // live streams received it (the `opened_in_tab` receipt); existing callers
    // ignore the body, so this stays backward compatible.
    if (req.method === "POST" && url.pathname.endsWith("/publish")) {
      const raw = await req.text()
      const ev = JSON.parse(raw) as DeriveEvent
      const f = frame(ev.type, raw)
      let delivered = 0
      for (const c of this.streams)
        try {
          c.enqueue(f)
          delivered++
        } catch {
          this.drop(c)
        }
      return Response.json({ delivered })
    }

    // Presence heartbeat (keep-alive / streamless join): upsert + return the roster.
    if (req.method === "POST" && url.pathname.endsWith("/heartbeat")) {
      const { viewer, now } = (await req.json()) as { viewer: Viewer; now: number }
      const e = this.viewers.get(viewer.id)
      if (e) {
        e.v = viewer
        e.t = now
      } else {
        this.viewers.set(viewer.id, { v: viewer, t: now, n: 0 })
      }
      return Response.json(this.roster(now))
    }

    return new Response("not found", { status: 404 })
  }

  // Keep-alive: ping open streams; a stream that's gone drops its viewer (the crash
  // backstop, since a hard-killed client may never fire `cancel`). Reschedule while
  // any remain.
  async alarm(): Promise<void> {
    const ping = enc.encode(": ping\n\n")
    let changed = false
    for (const c of this.streams)
      try {
        c.enqueue(ping)
      } catch {
        if (this.drop(c)) changed = true
      }
    if (changed) this.broadcastPresence()
    if (this.streams.size > 0) await this.state.storage.setAlarm(Date.now() + PING_MS)
  }
}

/**
 * Durable Object backplane (the Workers adapter). Routes the SSE stream to the
 * per-channel DO, fans events out through it, and tracks presence in it via the
 * stream lifecycle. `subscribe` is unused — the DO owns the streams, so `handleStream`
 * returns the DO's Response and the route never falls back to local SSE. Presence
 * `join`/`leave` are likewise handled inside the DO (connect/cancel), so the route
 * never calls them here; only `heartbeat` (the streamless path) round-trips.
 *
 * The `as unknown as Response` casts reconcile the two Response types in scope here
 * (the Workers `DurableObjectStub.fetch` Response vs the ambient global one); the
 * runtime value is a real workerd Response.
 */
export function createDoBackplane(rooms: DurableObjectNamespace): Backplane {
  const stub = (channel: string) => rooms.get(rooms.idFromName(channel))
  const presence: PresenceStore = {
    async heartbeat(channel, viewer, now) {
      const res = await stub(channel).fetch("https://do/heartbeat", {
        method: "POST",
        body: JSON.stringify({ viewer, now }),
      })
      return (await res.json()) as Viewer[]
    },
    // The DO drives join/leave off its own SSE connect/cancel, so these are never
    // called for the DO path (the route only calls them when handleStream is absent).
    join: () => [],
    leave: () => [],
  }
  return {
    publish(channel, e) {
      edgeWaitUntil(
        stub(channel)
          .fetch("https://do/publish", { method: "POST", body: JSON.stringify(e) })
          .catch(() => {}),
      )
    },
    subscribe() {
      return () => {}
    },
    presence,
    handleStream(_c: Context, channel: string, viewer?: Viewer) {
      // Only /events carries a viewer; the notification channel has no presence.
      const q = viewer ? `?v=${encodeURIComponent(JSON.stringify(viewer))}` : ""
      return stub(channel).fetch(`https://do/sse${q}`, { method: "GET" }) as unknown as Response
    },
    // Awaited (unlike `publish`) so the caller gets the room's live-stream count.
    async publishWithReceipt(channel, e) {
      try {
        const res = await stub(channel).fetch("https://do/publish", {
          method: "POST",
          body: JSON.stringify(e),
        })
        const body = (await res.json()) as { delivered?: number }
        return body.delivered ?? 0
      } catch {
        return 0
      }
    },
    // Long-poll by reading the room's own SSE stream: an isolate can't receive DO
    // fan-out in memory, but it can hold the same stream a browser tab would (no
    // viewer param, so presence is untouched) and wake on the first matching frame.
    async waitFor(channel, types: DomainEvent[], timeoutMs, release) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
      // One controller bounds the WHOLE wait, including the stub connect: a slow
      // DO cold-start must not outlive the deadline and leave the read unbounded.
      const ctl = new AbortController()
      const stop = () => {
        ctl.abort()
        void reader?.cancel().catch(() => {})
      }
      const timer = setTimeout(stop, timeoutMs)
      release?.addEventListener("abort", stop, { once: true })
      try {
        const res = await stub(channel).fetch("https://do/sse", {
          method: "GET",
          // Same two-Response-worlds reconciliation as handleStream below: the
          // runtime value is a real signal; only the ambient vs workers types differ.
          signal: ctl.signal as unknown as import("@cloudflare/workers-types").AbortSignal,
        })
        if (!res.body || ctl.signal.aborted) return null
        reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
        if (ctl.signal.aborted) {
          await reader.cancel().catch(() => {})
          return null
        }
        const dec = new TextDecoder()
        let buf = ""
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return null
          buf += dec.decode(value, { stream: true })
          // Frames are `event: <type>\ndata: <json>\n\n` (plus `: ping` comments
          // and the initial `ready` frame — neither matches a domain event type).
          for (;;) {
            const cut = buf.indexOf("\n\n")
            if (cut < 0) break
            const block = buf.slice(0, cut)
            buf = buf.slice(cut + 2)
            const type = block.match(/^event: (.+)$/m)?.[1]
            if (!type || !(types as string[]).includes(type)) continue
            const data = block.match(/^data: (.+)$/m)?.[1]
            try {
              return JSON.parse(data ?? "{}") as DeriveEvent
            } catch {
              return { type } as DeriveEvent
            }
          }
        }
      } catch {
        return null // timeout/release-aborted reads land here — a clean "nothing yet"
      } finally {
        clearTimeout(timer)
        release?.removeEventListener("abort", stop)
        reader?.cancel().catch(() => {})
      }
    },
  }
}

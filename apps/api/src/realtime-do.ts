import { AsyncLocalStorage } from "node:async_hooks"
import type {
  DurableObjectNamespace,
  DurableObjectState,
  ExecutionContext,
} from "@cloudflare/workers-types"
import type { Context } from "hono"
import type { Backplane, DeriveEvent, PresenceStore, Viewer } from "./bus"

/**
 * Per-request execution context, so the DO backplane's fire-and-forget publish can
 * ride `waitUntil` — Workers cancels un-awaited async once the response is sent, so
 * a bare `void fetch(...)` to the room DO would be killed before it lands. The Worker
 * entry wraps `app.fetch` in `edgeCtx.run(ctx, …)`.
 */
export const edgeCtx = new AsyncLocalStorage<ExecutionContext>()

const PING_MS = 20_000
const PRESENCE_TTL_MS = 45_000
const enc = new TextEncoder()
const frame = (event: string, data: string) => enc.encode(`event: ${event}\ndata: ${data}\n\n`)

/**
 * Realtime room: one Durable Object per channel (an artifact id, or `u:<userId>`
 * for the notification bell). It owns the SSE connections for that channel and
 * broadcasts events to them, so fan-out works across Worker isolates — every
 * client for a channel reaches the same DO. Presence is tracked here too.
 *
 * Plain SSE (not WebSocket) keeps the existing EventSource client unchanged; an
 * alarm pings open streams so intermediaries don't drop idle connections. This is
 * the connection-owning half of the Backplane port (see bus.ts).
 */
export class ArtifactRoom {
  private streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  private viewers = new Map<string, { v: Viewer; t: number }>()
  constructor(private state: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)

    // SSE connect: hold an open stream for this client.
    if (req.method === "GET") {
      const streams = this.streams
      const storage = this.state.storage
      let ctrl: ReadableStreamDefaultController<Uint8Array>
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          ctrl = c
          streams.add(c)
          c.enqueue(frame("ready", "{}"))
          if (streams.size === 1) void storage.setAlarm(Date.now() + PING_MS)
        },
        cancel() {
          streams.delete(ctrl)
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

    // Broadcast an event to every open stream on this channel.
    if (req.method === "POST" && url.pathname.endsWith("/publish")) {
      const raw = await req.text()
      const ev = JSON.parse(raw) as DeriveEvent
      const f = frame(ev.type, raw)
      for (const c of this.streams) {
        try {
          c.enqueue(f)
        } catch {
          this.streams.delete(c)
        }
      }
      return new Response("ok")
    }

    // Presence heartbeat: record + return the live viewers.
    if (req.method === "POST" && url.pathname.endsWith("/heartbeat")) {
      const { viewer, now } = (await req.json()) as { viewer: Viewer; now: number }
      this.viewers.set(viewer.id, { v: viewer, t: now })
      for (const [id, e] of this.viewers) if (now - e.t > PRESENCE_TTL_MS) this.viewers.delete(id)
      return Response.json([...this.viewers.values()].map((e) => e.v))
    }

    return new Response("not found", { status: 404 })
  }

  // Keep-alive: ping open streams (SSE comment), reschedule while any remain.
  async alarm(): Promise<void> {
    const ping = enc.encode(": ping\n\n")
    for (const c of this.streams) {
      try {
        c.enqueue(ping)
      } catch {
        this.streams.delete(c)
      }
    }
    if (this.streams.size > 0) await this.state.storage.setAlarm(Date.now() + PING_MS)
  }
}

/**
 * Durable Object backplane (the Workers adapter). Routes the SSE stream to the
 * per-channel DO, fans events out through it, and tracks presence in it. `subscribe`
 * is unused — the DO owns the streams, so `handleStream` returns the DO's Response
 * and the route never falls back to local SSE.
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
  }
  return {
    publish(channel, e) {
      const p = stub(channel)
        .fetch("https://do/publish", { method: "POST", body: JSON.stringify(e) })
        .catch(() => {})
      const ctx = edgeCtx.getStore()
      if (ctx) ctx.waitUntil(p)
      else void p
    },
    subscribe() {
      return () => {}
    },
    presence,
    handleStream(_c: Context, channel: string) {
      return stub(channel).fetch("https://do/sse", { method: "GET" }) as unknown as Response
    },
  }
}

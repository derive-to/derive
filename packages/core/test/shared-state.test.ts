import { describe, expect, it } from "vitest"
import {
  injectSharedStateScript,
  isSharedStateKey,
  SHARED_STATE_ACTIVITY_LIMIT,
  SHARED_STATE_CLIENT_JS,
  SHARED_STATE_KEY_PATTERN,
  SHARED_STATE_MAX_BYTES,
  SHARED_STATE_MAX_ITEMS,
  SHARED_STATE_MAX_KEYS,
  SHARED_STATE_SCRIPT,
} from "../src"

type RuntimeMessage = Record<string, unknown>
type MessageListener = (event: { source: unknown; data: RuntimeMessage }) => void

interface SharedHandle {
  readonly value: unknown
  readonly ready: Promise<unknown>
  onChange(listener: (value: unknown) => void): () => void
  update(id: string, patch: Record<string, unknown>): Promise<unknown>
}

interface DeriveRuntime {
  shared(key: string, initial: unknown): SharedHandle
  increment(by: number): { __derive_increment: number }
}

describe("shared-state contract", () => {
  it("keeps the public key and size limits small and explicit", () => {
    expect(isSharedStateKey("bugs")).toBe(true)
    expect(isSharedStateKey("bug_votes-2")).toBe(true)
    expect(isSharedStateKey("2bugs")).toBe(false)
    expect(isSharedStateKey("bugs/v2")).toBe(false)
    expect(isSharedStateKey(`b${"x".repeat(63)}`)).toBe(true)
    expect(isSharedStateKey(`b${"x".repeat(64)}`)).toBe(false)
    expect(SHARED_STATE_KEY_PATTERN).toBe("^[A-Za-z][A-Za-z0-9_-]{0,63}$")
    expect(SHARED_STATE_MAX_KEYS).toBe(16)
    expect(SHARED_STATE_MAX_ITEMS).toBe(2_000)
    expect(SHARED_STATE_MAX_BYTES).toBe(256 * 1024)
    expect(SHARED_STATE_ACTIVITY_LIMIT).toBe(50)
  })

  it("injects the runtime before artifact-authored scripts", () => {
    const html = "<!doctype html><html><head><script>boot()</script></head><body></body></html>"
    const injected = injectSharedStateScript(html)
    expect(injected.indexOf(SHARED_STATE_SCRIPT)).toBeGreaterThan(-1)
    expect(injected.indexOf(SHARED_STATE_SCRIPT)).toBeLessThan(injected.indexOf("boot()"))
  })

  it("inserts through adversarial tag-like input without a backtracking regex", () => {
    const prefixes = "<header><headless>".repeat(10_000)
    const html = `${prefixes}<HEAD data-theme="paper"><script>boot()</script></HEAD>`
    const injected = injectSharedStateScript(html)
    expect(injected.indexOf(SHARED_STATE_SCRIPT)).toBe(html.indexOf(">", prefixes.length) + 1)
    expect(injected.indexOf(SHARED_STATE_SCRIPT)).toBeLessThan(injected.indexOf("boot()"))
  })

  it("loads state, emits an atomic update, and applies the host result", async () => {
    const sent: RuntimeMessage[] = []
    let receive: MessageListener = () => {
      throw new Error("message listener was not installed")
    }
    const parent = { postMessage: (message: RuntimeMessage) => sent.push(message) }
    const frame = {
      derive: undefined as DeriveRuntime | undefined,
      addEventListener: (type: string, listener: MessageListener) => {
        if (type === "message") receive = listener
      },
      dispatchEvent: () => true,
    }
    const CustomEventStub = class {
      constructor(
        readonly type: string,
        readonly init?: unknown,
      ) {}
    }
    const load = Function("window", "parent", "CustomEvent", SHARED_STATE_CLIENT_JS) as (
      frame: typeof frame,
      parent: typeof parent,
      event: typeof CustomEventStub,
    ) => void
    load(frame, parent, CustomEventStub)

    const runtime = frame.derive
    if (!runtime) throw new Error("shared-state runtime did not load")
    expect(() => runtime.shared("bugs/v2", [])).toThrow("invalid shared-state key")

    const seen: unknown[] = []
    const bugs = runtime.shared("bugs", [])
    bugs.onChange((value) => seen.push(value))
    expect(seen).toEqual([[]])
    expect(sent).toHaveLength(0) // requests wait for the host handshake

    receive({ source: parent, data: { source: "derive-host", type: "shared-ready" } })
    const open = sent.at(-1)
    expect(open).toMatchObject({ source: "derive", type: "shared-open", key: "bugs" })
    receive({
      source: parent,
      data: {
        source: "derive-host",
        type: "shared-result",
        requestId: open?.requestId,
        key: "bugs",
        ok: true,
        value: [{ id: "item_1", title: "Stale vote", votes: 0 }],
        version: 1,
      },
    })
    await expect(bugs.ready).resolves.toEqual([{ id: "item_1", title: "Stale vote", votes: 0 }])

    const updated = bugs.update("item_1", { votes: runtime.increment(1) })
    const mutation = sent.at(-1)
    expect(mutation).toMatchObject({
      source: "derive",
      type: "shared-mutate",
      key: "bugs",
      mutation: {
        op: "update",
        id: "item_1",
        patch: { votes: { __derive_increment: 1 } },
      },
    })
    const next = [{ id: "item_1", title: "Stale vote", votes: 1 }]
    receive({
      source: parent,
      data: {
        source: "derive-host",
        type: "shared-result",
        requestId: mutation?.requestId,
        key: "bugs",
        ok: true,
        value: next,
        version: 2,
      },
    })
    await expect(updated).resolves.toEqual(next)
    expect(bugs.value).toEqual(next)
    expect(seen).toEqual([[], [{ id: "item_1", title: "Stale vote", votes: 0 }], next])

    receive({ source: parent, data: { source: "derive-host", type: "shared-resync" } })
    expect(sent.at(-1)).toMatchObject({ source: "derive", type: "shared-open", key: "bugs" })
  })

  it("exposes an initial read failure without discarding the local initial value", async () => {
    const sent: RuntimeMessage[] = []
    let receive: MessageListener = () => {
      throw new Error("message listener was not installed")
    }
    const parent = { postMessage: (message: RuntimeMessage) => sent.push(message) }
    const frame = {
      derive: undefined as DeriveRuntime | undefined,
      addEventListener: (type: string, listener: MessageListener) => {
        if (type === "message") receive = listener
      },
      dispatchEvent: () => true,
    }
    const CustomEventStub = class {
      constructor(
        readonly type: string,
        readonly init?: unknown,
      ) {}
    }
    const load = Function("window", "parent", "CustomEvent", SHARED_STATE_CLIENT_JS) as (
      frame: typeof frame,
      parent: typeof parent,
      event: typeof CustomEventStub,
    ) => void
    load(frame, parent, CustomEventStub)
    const runtime = frame.derive
    if (!runtime) throw new Error("shared-state runtime did not load")
    const bugs = runtime.shared("bugs", [])
    receive({ source: parent, data: { source: "derive-host", type: "shared-ready" } })
    const open = sent.at(-1)
    receive({
      source: parent,
      data: {
        source: "derive-host",
        type: "shared-result",
        requestId: open?.requestId,
        key: "bugs",
        ok: false,
        error: "network unavailable",
      },
    })
    await expect(bugs.ready).rejects.toThrow("network unavailable")
    expect(bugs.value).toEqual([])
  })
})

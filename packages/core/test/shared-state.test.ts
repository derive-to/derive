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
  setMine(slot: string, value: Record<string, unknown> | null): Promise<unknown>
  mine(slot: string): Record<string, unknown> | null
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

  it("keeps a source-free boot error blocking after iframe load without content", () => {
    type BrowserListener = (event: Record<string, unknown>) => void
    const sent: RuntimeMessage[] = []
    const listeners = new Map<string, BrowserListener>()
    const parent = { postMessage: (message: RuntimeMessage) => sent.push(message) }
    const frame = {
      derive: undefined as DeriveRuntime | undefined,
      document: {
        body: null,
      },
      addEventListener: (type: string, listener: BrowserListener) => listeners.set(type, listener),
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

    const message = "Failed to read the 'localStorage' property: Access is denied"
    listeners.get("error")?.({ error: { message }, message })
    expect(sent).toHaveLength(0) // queued until the host's iframe-load handshake
    listeners.get("message")?.({
      source: parent,
      data: { source: "derive-host", type: "shared-ready" },
    })
    expect(sent).toEqual([
      {
        source: "derive",
        type: "runtime-error",
        code: "sandbox-storage",
        phase: "loading",
      },
    ])

    listeners.get("load")?.({})
    listeners.get("error")?.({ error: { message: "late click handler failed" } })
    expect(sent.at(-1)).toMatchObject({
      source: "derive",
      type: "runtime-error",
      code: "script-error",
      phase: "loading",
    })
  })

  it("classifies a fallback exception after meaningful paint as fail-soft", () => {
    type BrowserListener = (event: Record<string, unknown>) => void
    const sent: RuntimeMessage[] = []
    const listeners = new Map<string, BrowserListener>()
    const parent = { postMessage: (message: RuntimeMessage) => sent.push(message) }
    const frame = {
      derive: undefined as DeriveRuntime | undefined,
      document: {
        body: {
          childElementCount: 1,
          innerText:
            "Thirty rendered rows remain useful even when an optional logo fallback fails. ".repeat(
              2,
            ),
          querySelector: () => null,
          querySelectorAll: () => ({ length: 1 }),
        },
      },
      addEventListener: (type: string, listener: BrowserListener) => listeners.set(type, listener),
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

    listeners.get("error")?.({
      error: { message: "Cannot set properties of null" },
      message: "Cannot set properties of null",
      target: frame,
    })
    listeners.get("message")?.({
      source: parent,
      data: { source: "derive-host", type: "shared-ready" },
    })
    expect(sent).toEqual([
      {
        source: "derive",
        type: "runtime-ready",
      },
      {
        source: "derive",
        type: "runtime-error",
        code: "script-error",
        phase: "ready",
      },
    ])
  })

  it("does not mistake an empty semantic app shell for meaningful content", () => {
    type BrowserListener = (event: Record<string, unknown>) => void
    const sent: RuntimeMessage[] = []
    const listeners = new Map<string, BrowserListener>()
    const parent = { postMessage: (message: RuntimeMessage) => sent.push(message) }
    const frame = {
      derive: undefined as DeriveRuntime | undefined,
      document: {
        body: {
          childElementCount: 1,
          innerText: "Loading…",
          querySelector: () => null,
          querySelectorAll: () => ({ length: 0 }),
        },
      },
      addEventListener: (type: string, listener: BrowserListener) => listeners.set(type, listener),
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

    listeners.get("error")?.({ error: { message: "boot failed" }, message: "boot failed" })
    listeners.get("message")?.({
      source: parent,
      data: { source: "derive-host", type: "shared-ready" },
    })
    expect(sent.at(-1)).toMatchObject({ code: "script-error", phase: "loading" })
  })

  it("treats a visible embedded document as meaningful content", () => {
    type BrowserListener = (event: Record<string, unknown>) => void
    const sent: RuntimeMessage[] = []
    const listeners = new Map<string, BrowserListener>()
    const parent = { postMessage: (message: RuntimeMessage) => sent.push(message) }
    const embedded = {
      hidden: false,
      tagName: "IFRAME",
      parentElement: null,
      getBoundingClientRect: () => ({
        top: 0,
        right: 800,
        bottom: 600,
        left: 0,
        width: 800,
        height: 600,
      }),
      getClientRects: () => ({ 0: { width: 800, height: 600 }, length: 1 }),
      getAttribute: () => null,
      getRootNode: () => null,
    }
    const frame = {
      derive: undefined as DeriveRuntime | undefined,
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      document: {
        body: {
          childElementCount: 1,
          innerText: "",
          querySelectorAll: (selector: string) =>
            selector.includes("iframe") ? { 0: embedded, length: 1 } : { length: 0 },
        },
      },
      addEventListener: (type: string, listener: BrowserListener) => listeners.set(type, listener),
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

    listeners.get("load")?.({})
    listeners.get("message")?.({
      source: parent,
      data: { source: "derive-host", type: "shared-ready" },
    })
    expect(sent).toEqual([{ source: "derive", type: "runtime-ready" }])
  })

  it("does not attribute platform script failures to the artifact author", () => {
    type BrowserListener = (event: Record<string, unknown>) => void
    const sent: RuntimeMessage[] = []
    const listeners = new Map<string, BrowserListener>()
    const parent = { postMessage: (message: RuntimeMessage) => sent.push(message) }
    const frame = {
      derive: undefined as DeriveRuntime | undefined,
      document: { body: null },
      addEventListener: (type: string, listener: BrowserListener) => listeners.set(type, listener),
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

    for (const src of [
      "https://raw.derive.page/raw/derive-client.js",
      "https://static.cloudflareinsights.com/beacon.min.js/v-test",
    ]) {
      listeners.get("error")?.({
        error: null,
        message: "Failed to load platform script",
        target: { tagName: "SCRIPT", src },
        filename: src,
      })
      listeners.get("error")?.({
        error: { message: "Platform script threw" },
        message: "Platform script threw",
        target: frame,
        filename: src,
      })
    }
    listeners.get("message")?.({
      source: parent,
      data: { source: "derive-host", type: "shared-ready" },
    })
    expect(sent).toEqual([])
  })

  it("excludes hidden markers, hidden rich nodes, and source text from readiness", () => {
    type BrowserListener = (event: Record<string, unknown>) => void
    const sent: RuntimeMessage[] = []
    const listeners = new Map<string, BrowserListener>()
    const parent = { postMessage: (message: RuntimeMessage) => sent.push(message) }
    const hidden = { hidden: true }
    const frame = {
      derive: undefined as DeriveRuntime | undefined,
      document: {
        body: {
          childElementCount: 3,
          innerText: "Loading…",
          textContent:
            "A deliberately long inline script source that exceeds the old readiness threshold but renders nothing useful to a viewer.",
          querySelector: () => hidden,
          querySelectorAll: () => ({ 0: hidden, length: 1 }),
        },
      },
      addEventListener: (type: string, listener: BrowserListener) => listeners.set(type, listener),
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

    listeners.get("error")?.({ error: { message: "boot failed" }, message: "boot failed" })
    listeners.get("message")?.({
      source: parent,
      data: { source: "derive-host", type: "shared-ready" },
    })
    expect(sent).toEqual([
      {
        source: "derive",
        type: "runtime-error",
        code: "script-error",
        phase: "loading",
      },
    ])
  })

  it("loads state, emits an atomic update, and applies the host result", async () => {
    const sent: RuntimeMessage[] = []
    let receive: MessageListener = () => {
      throw new Error("message listener was not installed")
    }
    const parent = { postMessage: (message: RuntimeMessage) => sent.push(message) }
    const frame = {
      derive: undefined as DeriveRuntime | undefined,
      document: {
        body: null,
      },
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
        mine: { reaction: "item_1" },
      },
    })
    await expect(bugs.ready).resolves.toEqual([{ id: "item_1", title: "Stale vote", votes: 0 }])
    expect(bugs.mine("reaction")).toEqual({ id: "item_1", title: "Stale vote", votes: 0 })

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

    const setMine = bugs.setMine("reaction", { kind: "up" })
    const actorMutation = sent.at(-1)
    expect(bugs.mine("reaction")).toEqual({ id: "item_1", kind: "up" })
    expect(seen.at(-1)).toEqual([{ id: "item_1", kind: "up" }])
    expect(actorMutation).toMatchObject({
      source: "derive",
      type: "shared-mutate",
      key: "bugs",
      mutation: {
        op: "set_mine",
        slot: "reaction",
        value: { kind: "up" },
      },
    })
    const actorValue = [{ id: "item_2", kind: "up" }]
    receive({
      source: parent,
      data: {
        source: "derive-host",
        type: "shared-result",
        requestId: actorMutation?.requestId,
        key: "bugs",
        ok: true,
        value: actorValue,
        version: 3,
        mine: { reaction: "item_2" },
      },
    })
    await expect(setMine).resolves.toEqual(actorValue)
    expect(bugs.mine("reaction")).toEqual({ id: "item_2", kind: "up" })

    const failedMine = bugs.setMine("reaction", null)
    const failedMutation = sent.at(-1)
    expect(bugs.mine("reaction")).toBeNull()
    expect(bugs.value).toEqual([])
    receive({
      source: parent,
      data: {
        source: "derive-host",
        type: "shared-result",
        requestId: failedMutation?.requestId,
        key: "bugs",
        ok: false,
        error: "write failed",
      },
    })
    await expect(failedMine).rejects.toThrow("write failed")
    expect(bugs.mine("reaction")).toEqual({ id: "item_2", kind: "up" })
    expect(bugs.value).toEqual(actorValue)
    expect(sent.at(-1)).toMatchObject({ source: "derive", type: "shared-open", key: "bugs" })
    expect(() => bugs.setMine("", {})).toThrow("mine slot must be a 1-128 character string")
    expect(() => bugs.setMine("reaction", [] as unknown as Record<string, unknown>)).toThrow(
      "setMine value must be an object or null",
    )

    receive({
      source: parent,
      data: {
        source: "derive-host",
        type: "shared-updated",
        key: "bugs",
        value: actorValue,
        version: 4,
      },
    })
    expect(bugs.mine("reaction")).toEqual({ id: "item_2", kind: "up" })
    receive({ source: parent, data: { source: "derive-host", type: "shared-resync" } })
    const resync = sent.at(-1)
    expect(resync).toMatchObject({ source: "derive", type: "shared-open", key: "bugs" })
    receive({
      source: parent,
      data: {
        source: "derive-host",
        type: "shared-result",
        requestId: resync?.requestId,
        key: "bugs",
        ok: true,
        value: actorValue,
        version: 4,
        mine: {},
      },
    })
    expect(bugs.mine("reaction")).toBeNull()
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

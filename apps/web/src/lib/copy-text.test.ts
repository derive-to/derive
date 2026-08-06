import { afterEach, describe, expect, it, vi } from "vitest"
import { copyText } from "./copy-text"

// vitest runs in node here, so `document` is absent unless a test provides one. That
// asymmetry is the point: the secure-context branch and the fallback branch can never
// both be exercised by simply running the app, so each is pinned explicitly.
afterEach(() => vi.unstubAllGlobals())

/** A minimal document that records whether execCommand("copy") was reached. */
const stubDocument = (execResult: boolean) => {
  const calls: string[] = []
  const el = {
    value: "",
    style: {} as Record<string, string>,
    setAttribute: () => {},
    select: () => calls.push("select"),
    setSelectionRange: () => {},
    remove: () => calls.push("remove"),
  }
  vi.stubGlobal("document", {
    createElement: () => el,
    body: { appendChild: () => calls.push("append") },
    execCommand: (cmd: string) => {
      calls.push(cmd)
      return execResult
    },
  })
  return { el, calls }
}

describe("copyText", () => {
  it("uses the Clipboard API where it exists", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    expect(await copyText("hello")).toBe(true)
    expect(writeText).toHaveBeenCalledWith("hello")
  })

  it("still copies on a NON-SECURE origin, where navigator.clipboard is undefined", async () => {
    // The case this exists for: plain http to a hostname or LAN IP. Previously every
    // copy in the app either errored or silently did nothing here.
    vi.stubGlobal("navigator", {})
    const { el, calls } = stubDocument(true)
    expect(await copyText("hello")).toBe(true)
    expect(el.value).toBe("hello")
    expect(calls).toContain("copy")
    // The scratch element must not be left behind on the page.
    expect(calls).toContain("remove")
  })

  it("falls back when the Clipboard API exists but REJECTS", async () => {
    // Permission denied, or called outside a user gesture. The old code treated this as
    // terminal; there is still a route that works.
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    })
    const { calls } = stubDocument(true)
    expect(await copyText("hello")).toBe(true)
    expect(calls).toContain("copy")
  })

  it("reports false when nothing worked, so callers can say so honestly", async () => {
    vi.stubGlobal("navigator", {})
    stubDocument(false)
    expect(await copyText("hello")).toBe(false)
  })

  it("cleans up even when execCommand throws", async () => {
    vi.stubGlobal("navigator", {})
    const calls: string[] = []
    vi.stubGlobal("document", {
      createElement: () => ({
        style: {} as Record<string, string>,
        setAttribute: () => {},
        select: () => {
          throw new Error("boom")
        },
        setSelectionRange: () => {},
        remove: () => calls.push("remove"),
      }),
      body: { appendChild: () => {} },
      execCommand: () => true,
    })
    expect(await copyText("hello")).toBe(false)
    expect(calls).toContain("remove")
  })

  it("returns false rather than throwing with no document at all (SSR)", async () => {
    vi.stubGlobal("navigator", {})
    vi.stubGlobal("document", undefined)
    expect(await copyText("hello")).toBe(false)
  })
})

import { afterEach, describe, expect, it, vi } from "vitest"
import { randomId } from "./random-id"

afterEach(() => vi.unstubAllGlobals())

describe("randomId", () => {
  it("uses crypto.randomUUID where it exists", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "11111111-2222-3333-4444-555555555555" })
    expect(randomId()).toBe("11111111-2222-3333-4444-555555555555")
  })

  it("still returns an id in a NON-SECURE context, where randomUUID is undefined", () => {
    // Plain http to a hostname or a LAN IP: `crypto` exists, `randomUUID` does not. This
    // is the case that silently broke commenting — the call threw mid-handler, so the
    // request never fired and nothing surfaced.
    vi.stubGlobal("crypto", {})
    const id = randomId()
    expect(id).toBeTruthy()
    expect(typeof id).toBe("string")
    expect(id.length).toBeGreaterThan(8)
  })

  it("survives crypto being absent entirely", () => {
    vi.stubGlobal("crypto", undefined)
    expect(randomId()).toBeTruthy()
  })

  it("does not repeat itself", () => {
    vi.stubGlobal("crypto", {})
    const ids = new Set(Array.from({ length: 500 }, () => randomId()))
    expect(ids.size).toBe(500)
  })
})

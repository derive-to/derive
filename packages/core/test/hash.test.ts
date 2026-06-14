import { describe, expect, it } from "vitest"
import { sha256Hex } from "../src/hash"

describe("sha256Hex", () => {
  it("returns the known digest for a fixed input", async () => {
    // The canonical sha256("abc").
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
  })

  it("digests empty input and is deterministic + content-addressed", async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    )
    const a = await sha256Hex(new TextEncoder().encode("same"))
    const b = await sha256Hex(new TextEncoder().encode("same"))
    const c = await sha256Hex(new TextEncoder().encode("different"))
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})

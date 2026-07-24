import { beforeEach, describe, expect, it, vi } from "vitest"
import { getGuestName, setGuestName } from "./guest-name"

// This suite runs in vitest's "node" environment (vitest.config.ts), not jsdom — there's no
// global `localStorage`. guest-id.test.ts never needed a stub because its cases exercise the
// SSR guard / pure transforms, not storage itself; this helper always touches `localStorage`
// directly, so give it a minimal in-memory Storage stand-in via vitest's own global-stubbing.
class MemoryStorage implements Storage {
  private store = new Map<string, string>()
  get length() {
    return this.store.size
  }
  clear = () => this.store.clear()
  getItem = (key: string) => this.store.get(key) ?? null
  key = (index: number) => [...this.store.keys()][index] ?? null
  removeItem = (key: string) => void this.store.delete(key)
  setItem = (key: string, value: string) => void this.store.set(key, value)
}
vi.stubGlobal("localStorage", new MemoryStorage())

describe("guest name storage", () => {
  beforeEach(() => localStorage.clear())

  it("round-trips a trimmed name", () => {
    setGuestName("  Glen  ")
    expect(getGuestName()).toBe("Glen")
  })

  it("returns empty when unset", () => {
    expect(getGuestName()).toBe("")
  })

  it("caps at 80 characters", () => {
    setGuestName("x".repeat(120))
    expect(getGuestName()).toHaveLength(80)
  })
})

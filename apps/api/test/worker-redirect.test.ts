import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// workerd throws on redirect: "error", so a fetch that sets it fails only in production.
describe("worker fetches", () => {
  it("never ask for redirect error", () => {
    const root = join(__dirname, "../src")
    const offenders = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => /redirect:\s*"error"/.test(readFileSync(join(root, file), "utf8")))
    expect(offenders).toEqual([])
  })
})

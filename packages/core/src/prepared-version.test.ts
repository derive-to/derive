import { describe, expect, it } from "vitest"
import {
  decodePreparedVersion,
  encodePreparedVersion,
  prepareVersion,
  resolvePreparedNode,
} from "./prepared-version"

const SOURCE = `<!doctype html><html><body>
  <h2>Résumé 🚀</h2><p>Café é and 𠜎.</p>
  <h3>Nested</h3><p>Exact bytes.</p>
</body></html>`

describe("prepared versions", () => {
  it("round-trips exact UTF-16 and UTF-8 node spans", () => {
    const prepared = prepareVersion("source-key", SOURCE, "text/html")
    expect(prepared).not.toBeNull()
    const encoded = encodePreparedVersion(prepared as NonNullable<typeof prepared>)
    expect(encoded).not.toBeNull()
    const decoded = decodePreparedVersion(encoded as Uint8Array, {
      sourceKey: "source-key",
      contentType: "text/html",
      sourceBytes: new TextEncoder().encode(SOURCE).byteLength,
    })
    expect(decoded).toEqual(prepared)

    const sourceBytes = new TextEncoder().encode(SOURCE)
    for (const node of (decoded as NonNullable<typeof decoded>).nodes) {
      const byteSlice = sourceBytes.slice(node.byteStart, node.byteEnd)
      const text = new TextDecoder("utf-8", { fatal: true }).decode(byteSlice)
      expect(text).toBe(SOURCE.slice(node.start, node.end))
      expect(new TextEncoder().encode(text).byteLength).toBe(node.byteEnd - node.byteStart)
    }
    expect(resolvePreparedNode(decoded as NonNullable<typeof decoded>, "sec:résumé-")).toBeNull()
    expect(resolvePreparedNode(decoded as NonNullable<typeof decoded>, "sec:resume")).not.toBeNull()
  })

  it("rejects stale, malformed, truncated, and oversized sidecars", () => {
    const prepared = prepareVersion("source-key", SOURCE, "text/html")
    const encoded = encodePreparedVersion(prepared as NonNullable<typeof prepared>) as Uint8Array
    expect(
      decodePreparedVersion(encoded, { sourceKey: "other", contentType: "text/html" }),
    ).toBeNull()
    expect(
      decodePreparedVersion(encoded, { sourceKey: "source-key", contentType: "text/markdown" }),
    ).toBeNull()
    expect(
      decodePreparedVersion(encoded, {
        sourceKey: "source-key",
        contentType: "text/html",
        sourceBytes: encoded.byteLength,
      }),
    ).toBeNull()
    expect(
      decodePreparedVersion(encoded.slice(0, -1), {
        sourceKey: "source-key",
        contentType: "text/html",
      }),
    ).toBeNull()
    expect(encodePreparedVersion(prepared as NonNullable<typeof prepared>, 8)).toBeNull()
  })
})

import { describe, expect, it } from "vitest"
import { mimeFor } from "../src/mime"

describe("mimeFor", () => {
  it("maps known extensions (case-insensitive, by last segment)", () => {
    expect(mimeFor("index.html")).toBe("text/html; charset=utf-8")
    expect(mimeFor("README.MD")).toBe("text/markdown; charset=utf-8")
    expect(mimeFor("app.js")).toBe("text/javascript; charset=utf-8")
    expect(mimeFor("data.json")).toBe("application/json; charset=utf-8")
    expect(mimeFor("logo.svg")).toBe("image/svg+xml")
    expect(mimeFor("photo.JPEG")).toBe("image/jpeg")
    expect(mimeFor("font.woff2")).toBe("font/woff2")
  })

  it("falls back to octet-stream for unknown or missing extensions", () => {
    expect(mimeFor("mystery.xyz")).toBe("application/octet-stream")
    expect(mimeFor("noext")).toBe("application/octet-stream")
  })

  it("uses the final extension of a multi-dot path", () => {
    expect(mimeFor("bundle.min.css")).toBe("text/css; charset=utf-8")
    expect(mimeFor("archive.tar.gz")).toBe("application/octet-stream")
  })
})

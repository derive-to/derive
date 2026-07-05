import { describe, expect, it } from "vitest"
import {
  anonName,
  isWorkspaceRole,
  rewriteAbsoluteUrls,
  str,
  toBody,
  visibilityOf,
} from "../src/lib/http"

describe("rewriteAbsoluteUrls — keep bundle pages inside their path scope", () => {
  const p = "/raw/abc/v/1"

  it("prefixes root-absolute URLs in the relevant attributes", () => {
    expect(rewriteAbsoluteUrls('<a href="/about">', p)).toBe(`<a href="${p}/about">`)
    expect(rewriteAbsoluteUrls("<img src='/logo.png'>", p)).toBe(`<img src='${p}/logo.png'>`)
    expect(rewriteAbsoluteUrls('<form action="/submit">', p)).toBe(`<form action="${p}/submit">`)
    expect(rewriteAbsoluteUrls('<video poster="/p.png">', p)).toBe(`<video poster="${p}/p.png">`)
  })

  it("prefixes CSS url(...) references, quoted or bare", () => {
    expect(rewriteAbsoluteUrls("background:url(/bg.png)", p)).toBe(`background:url(${p}/bg.png)`)
    expect(rewriteAbsoluteUrls("background:url('/bg.png')", p)).toBe(
      `background:url('${p}/bg.png')`,
    )
  })

  it("does NOT touch protocol-relative or absolute URLs (no escape, no double-rewrite)", () => {
    expect(rewriteAbsoluteUrls('<a href="//cdn.example.com/x">', p)).toBe(
      '<a href="//cdn.example.com/x">',
    )
    expect(rewriteAbsoluteUrls('<a href="https://example.com/x">', p)).toBe(
      '<a href="https://example.com/x">',
    )
  })

  it("leaves relative URLs and unrelated attributes alone", () => {
    expect(rewriteAbsoluteUrls('<a href="about.html">', p)).toBe('<a href="about.html">')
    expect(rewriteAbsoluteUrls('<a data-x="/y">', p)).toBe('<a data-x="/y">')
  })
})

describe("anonName — deterministic friendly name from a seed", () => {
  it("is stable for a given seed", () => {
    expect(anonName("viewer-1")).toBe(anonName("viewer-1"))
  })

  it("has an adjective-animal-NN shape with a two-digit suffix", () => {
    const name = anonName("seed")
    expect(name).toMatch(/-\d{1,2}$/)
    expect(name.split("-").length).toBeGreaterThanOrEqual(3)
  })

  it("varies across seeds (not a constant)", () => {
    const names = new Set(Array.from({ length: 20 }, (_, i) => anonName(`viewer-${i}`)))
    expect(names.size).toBeGreaterThan(1)
  })
})

describe("isWorkspaceRole — the Admin/Creator/Viewer workspace roles", () => {
  it("accepts owner/editor/commenter and rejects a bare viewer and junk", () => {
    expect(isWorkspaceRole("owner")).toBe(true)
    expect(isWorkspaceRole("editor")).toBe(true)
    expect(isWorkspaceRole("commenter")).toBe(true)
    // A read-only "viewer" is not offered as a workspace role (a Viewer can comment).
    expect(isWorkspaceRole("viewer")).toBe(false)
    for (const bad of ["admin", "", null, undefined, 1, {}])
      expect(isWorkspaceRole(bad)).toBe(false)
  })
})

describe("str / visibilityOf — input coercion", () => {
  it("str returns a non-empty string or undefined", () => {
    expect(str("x")).toBe("x")
    expect(str("")).toBeUndefined()
    expect(str(5)).toBeUndefined()
    expect(str(null)).toBeUndefined()
  })

  it("visibilityOf accepts only the known visibilities", () => {
    for (const v of ["public", "link", "org", "password", "private"])
      expect(visibilityOf(v)).toBe(v)
    for (const bad of ["secret", "", "PUBLIC", null, 3]) expect(visibilityOf(bad)).toBeUndefined()
  })
})

describe("toBody — Uint8Array to a detached ArrayBuffer copy", () => {
  it("copies the bytes and does not alias the source", () => {
    const src = Uint8Array.from([1, 2, 3])
    const buf = toBody(src)
    expect(new Uint8Array(buf)).toEqual(Uint8Array.from([1, 2, 3]))
    src[0] = 99 // mutate the source after the copy
    expect(new Uint8Array(buf)[0]).toBe(1) // copy is unaffected
  })
})

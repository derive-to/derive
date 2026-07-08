import { describe, expect, it } from "vitest"
import {
  anonName,
  isWorkspaceRole,
  legacyAccessOf,
  rewriteAbsoluteUrls,
  str,
  toBody,
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

describe("str / legacyAccessOf — input coercion", () => {
  it("str returns a non-empty string or undefined", () => {
    expect(str("x")).toBe("x")
    expect(str("")).toBeUndefined()
    expect(str(5)).toBeUndefined()
    expect(str(null)).toBeUndefined()
  })

  it("legacyAccessOf maps a legacy visibility (+ aliases) onto the v2 access triple", () => {
    expect(legacyAccessOf("private")).toEqual({
      workspace_access: "none",
      link_role: "none",
      listed: "none",
    })
    expect(legacyAccessOf("org")).toEqual({
      workspace_access: "member",
      link_role: "none",
      listed: "workspace",
    })
    // public restores the world link at general_role (default viewer).
    expect(legacyAccessOf("public")).toEqual({
      workspace_access: "member",
      link_role: "viewer",
      listed: "public",
    })
    expect(legacyAccessOf("public", "commenter")).toEqual({
      workspace_access: "member",
      link_role: "commenter",
      listed: "public",
    })
    // Pre-collapse client values keep working: link/password → public,
    // unlisted → private, workspace → org.
    expect(legacyAccessOf("link")?.listed).toBe("public")
    expect(legacyAccessOf("password")?.listed).toBe("public")
    expect(legacyAccessOf("unlisted")?.listed).toBe("none")
    expect(legacyAccessOf("workspace")?.listed).toBe("workspace")
    for (const bad of ["secret", "", "PUBLIC"]) expect(legacyAccessOf(bad)).toBeUndefined()
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

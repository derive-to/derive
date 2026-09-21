import { describe, expect, it } from "vitest"
import { pickShareUrl } from "./share-url"

const canonical = "https://derive.to/artifacts/q3-update-k7m2x9pq"
const sub = { host: "acme.derive.page", url: "https://acme.derive.page/q3-update-k7m2x9pq" }
const custom = { host: "docs.acme.com", url: "https://docs.acme.com/q3-update-k7m2x9pq" }

describe("pickShareUrl", () => {
  it("hands out the workspace domain link for a plain view link", () => {
    expect(
      pickShareUrl({
        canonical,
        domains: [sub],
        base: "derive.page",
        linkRole: "viewer",
        locked: false,
      }),
    ).toEqual({ url: sub.url, host: sub.host })
  })

  it("prefers the customer's own domain over the platform subdomain", () => {
    expect(
      pickShareUrl({
        canonical,
        domains: [sub, custom],
        base: "derive.page",
        linkRole: "viewer",
        locked: false,
      }).host,
    ).toBe(custom.host)
  })

  it("stays on the app for links the branded host cannot honour", () => {
    const on = (linkRole: string, locked = false) =>
      pickShareUrl({ canonical, domains: [sub], base: "derive.page", linkRole, locked })
    // No link at all: only members can open it, and they need the app.
    expect(on("none")).toEqual({ url: canonical, host: null })
    // A commenter/editor link needs the viewer's comment + edit surface.
    expect(on("commenter")).toEqual({ url: canonical, host: null })
    expect(on("editor")).toEqual({ url: canonical, host: null })
    // A password lock can only be unlocked on the app origin.
    expect(on("viewer", true)).toEqual({ url: canonical, host: null })
  })

  it("stays on the app when the workspace has no domain", () => {
    expect(
      pickShareUrl({
        canonical,
        domains: [],
        base: "derive.page",
        linkRole: "viewer",
        locked: false,
      }),
    ).toEqual({ url: canonical, host: null })
  })
})

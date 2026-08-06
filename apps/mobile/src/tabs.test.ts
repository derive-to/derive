import { describe, expect, it } from "vitest"
import { activeTabFor, navScript, pathOf, TABS } from "./tabs"

// The tab bar is the shell's main answer to Guideline 4.2, so the mapping below is what
// decides whether it looks correct or looks broken. It is also the part that rots quietly
// when a web route is renamed: nothing crashes, the wrong tab just lights up.

describe("activeTabFor", () => {
  it("lights the tab that owns the path", () => {
    expect(activeTabFor("https://derive.to/")).toBe("library")
    expect(activeTabFor("https://derive.to/favorites")).toBe("favorites")
    expect(activeTabFor("https://derive.to/following")).toBe("following")
    expect(activeTabFor("https://derive.to/settings")).toBe("settings")
  })

  it("keeps a tab lit on its sub-routes", () => {
    // /settings REDIRECTS to /settings/profile, so this is not hypothetical: without
    // sub-route ownership the Settings tab would go dark the instant you tapped it.
    // Confirmed against the running app.
    expect(activeTabFor("https://derive.to/settings/profile")).toBe("settings")
    expect(activeTabFor("https://derive.to/settings/security")).toBe("settings")
    expect(activeTabFor("https://derive.to/settings/billing")).toBe("settings")
  })

  it("selects NOTHING where no tab owns the path", () => {
    // An artifact or a profile is not "in" a tab. Falling back to Library would tell the
    // person they are somewhere they are not.
    expect(activeTabFor("https://derive.to/artifacts/abc")).toBeNull()
    expect(activeTabFor("https://derive.to/users/anir")).toBeNull()
    expect(activeTabFor("https://derive.to/brandprint")).toBeNull()
  })

  it("does not let Library swallow every path", () => {
    // "/" owns only itself; a naive startsWith("/") would match everything.
    expect(activeTabFor("https://derive.to/anything")).toBeNull()
  })

  it("ignores a trailing slash and a query", () => {
    expect(activeTabFor("https://derive.to/favorites/")).toBe("favorites")
    expect(activeTabFor("https://derive.to/favorites?sort=recent")).toBe("favorites")
  })

  it("does not match a path that merely starts with a tab's name", () => {
    expect(activeTabFor("https://derive.to/favorites-archive")).toBeNull()
    expect(activeTabFor("https://derive.to/settingsx")).toBeNull()
  })

  it("survives junk instead of throwing", () => {
    expect(activeTabFor("not a url")).toBe("library") // pathOf falls back to "/"
  })
})

describe("pathOf", () => {
  it("extracts the path and falls back safely", () => {
    expect(pathOf("https://derive.to/a/b?x=1#y")).toBe("/a/b")
    expect(pathOf("nonsense")).toBe("/")
  })
})

describe("navScript", () => {
  it("drives the SPA router rather than reloading", () => {
    // Setting the web view's source would re-boot the app and read as a page load, which
    // is the exact tell a native shell must not have.
    const s = navScript("/favorites")
    expect(s).toContain("history.pushState")
    expect(s).toContain("PopStateEvent")
    expect(s).not.toContain("location.href =")
    expect(s).not.toContain("location.replace")
  })

  it("treats a re-tap of the current tab as scroll-to-top", () => {
    expect(navScript("/favorites")).toContain("scrollTo")
  })

  it("encodes the path so it can never become an injection sink", () => {
    expect(navScript('"); alert(1); //')).toContain('\\"); alert(1); //')
  })
})

describe("TABS", () => {
  it("has unique keys and paths that map back to themselves", () => {
    expect(new Set(TABS.map((t) => t.key)).size).toBe(TABS.length)
    for (const t of TABS) expect(activeTabFor(`https://derive.to${t.path}`)).toBe(t.key)
  })
})

import { describe, expect, it } from "vitest"
import type { Role } from "@/api"
import { ALL_EVENTS, roleLabel, roleValue, WS_ROLES } from "./roles"

describe("workspace roles", () => {
  it("maps each canonical role to its display label", () => {
    expect(roleLabel("owner")).toBe("Admin")
    expect(roleLabel("editor")).toBe("Creator")
    expect(roleLabel("commenter")).toBe("Viewer")
  })

  it("falls back to Viewer for an unknown role", () => {
    expect(roleLabel("mystery" as Role)).toBe("Viewer")
  })

  it("normalizes a legacy bare viewer onto commenter", () => {
    expect(roleValue("viewer")).toBe("commenter")
    expect(roleValue("editor")).toBe("editor")
    expect(roleValue("owner")).toBe("owner")
  })

  it("exposes the three-role vocabulary and the webhook event set", () => {
    expect(WS_ROLES.map((r) => r.value)).toEqual(["owner", "editor", "commenter"])
    expect(ALL_EVENTS).toContain("version.published")
    expect(ALL_EVENTS).toHaveLength(3)
  })
})

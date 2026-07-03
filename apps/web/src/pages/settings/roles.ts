import type { Role } from "@/api"

// Workspace membership presented as three simple roles. The values are the
// canonical Role vocabulary; the labels are what people see.
export const WS_ROLES: { value: Role; label: string; hint: string }[] = [
  { value: "owner", label: "Admin", hint: "Add people, manage settings" },
  { value: "editor", label: "Creator", hint: "Create & publish" },
  { value: "commenter", label: "Viewer", hint: "Read & comment" },
]

export const roleLabel = (r: Role): string => WS_ROLES.find((x) => x.value === r)?.label ?? "Viewer"

// A historical bare "viewer" maps onto the Viewer (commenter) option.
export const roleValue = (r: Role): Role => (r === "viewer" ? "commenter" : r)

// The events a webhook can subscribe to (all selected = no filter sent).
export const ALL_EVENTS = ["comment.created", "comment.resolved", "version.published"] as const

import type { Role } from "@/api"
import {
  SelectMenu,
  SelectMenuContent,
  SelectMenuItem,
  SelectMenuTrigger,
} from "@/components/ui/select-menu"

const ROLES: Role[] = ["viewer", "commenter", "editor", "owner"]

// Rendered role labels, sentence-case ("Viewer") — one casing for the same data
// everywhere (ShareDialog's read-only rows import this map too).
export const ROLE_LABELS: Record<Role, string> = {
  viewer: "Viewer",
  commenter: "Commenter",
  editor: "Editor",
  owner: "Owner",
}

// The role picker — the ROLES list over SelectMenu, not the real Select. Both
// call sites (this dialog and the collection share dialog) live inside a modal
// Dialog, and Radix's Select can't opt out of the outside-pointer-events lock
// that fights a host Dialog (see ui/select-menu.tsx). One thin wrapper so every
// share surface reads the same options with the same API.
export function RoleSelect({
  value,
  onChange,
  className,
  "aria-label": ariaLabel = "Role",
  "data-testid": testId,
}: {
  value: Role
  onChange: (role: Role) => void
  className?: string
  "aria-label"?: string
  "data-testid"?: string
}) {
  return (
    <SelectMenu value={value} onValueChange={(v) => onChange(v as Role)}>
      <SelectMenuTrigger aria-label={ariaLabel} data-testid={testId} className={className}>
        {ROLE_LABELS[value]}
      </SelectMenuTrigger>
      <SelectMenuContent>
        {ROLES.map((r) => (
          <SelectMenuItem key={r} value={r}>
            {ROLE_LABELS[r]}
          </SelectMenuItem>
        ))}
      </SelectMenuContent>
    </SelectMenu>
  )
}

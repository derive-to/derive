import type { Role } from "@/api"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const ROLES: Role[] = ["viewer", "commenter", "editor", "owner"]

// Rendered labels stay sentence-case ("Viewer"), matching ShareDialog's
// read-only rows — one casing for the same data everywhere.
const LABEL: Record<Role, string> = {
  viewer: "Viewer",
  commenter: "Commenter",
  editor: "Editor",
  owner: "Owner",
}

// The role picker — the ROLES list over the canonical shadcn Select, kept as one
// thin wrapper so every share surface reads the same options with the same API.
export function RoleSelect({
  value,
  onChange,
  className,
  name = "role",
  "aria-label": ariaLabel = "Role",
  "data-testid": testId,
}: {
  value: Role
  onChange: (role: Role) => void
  className?: string
  name?: string
  "aria-label"?: string
  "data-testid"?: string
}) {
  return (
    <Select name={name} value={value} onValueChange={(v) => onChange(v as Role)}>
      <SelectTrigger aria-label={ariaLabel} data-testid={testId} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ROLES.map((r) => (
          <SelectItem key={r} value={r}>
            {LABEL[r]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

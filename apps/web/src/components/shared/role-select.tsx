import type { Role } from "@/api"
import { cn } from "@/lib/utils"

const ROLES: Role[] = ["viewer", "commenter", "editor", "owner"]

// Native <select> styled to match Input — used wherever a member's role is
// chosen (collection share, artifact share). Native keeps keyboard + screen
// reader behaviour for free; swap for a Radix Select later without call-site churn.
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
    <select
      aria-label={ariaLabel}
      data-testid={testId}
      value={value}
      onChange={(e) => onChange(e.target.value as Role)}
      className={cn(
        "rounded-md border border-input bg-card px-2 py-2 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {ROLES.map((r) => (
        <option key={r} value={r}>
          {r}
        </option>
      ))}
    </select>
  )
}

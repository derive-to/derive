import { cn } from "@/lib/utils"

// The one register for "this control exists, but your role doesn't reach it".
// When a role hides a control, absence gets EXPLAINED — a silently missing
// invite form reads as a bug, not a permission. One sentence, one shape,
// everywhere: "Only a workspace Admin can <verb phrase>."
export function AdminNote({
  can,
  role = "workspace Admin",
  className,
  testId,
}: {
  /** The verb phrase: "create automations", "change billing", "invite people". */
  can: string
  role?: string
  className?: string
  testId?: string
}) {
  return (
    <p data-testid={testId} className={cn("text-sm text-muted-foreground", className)}>
      Only a {role} can {can}.
    </p>
  )
}

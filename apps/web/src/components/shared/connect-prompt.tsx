import type { ReactNode } from "react"

// A source that is not connected yet, or cannot be on this instance: one muted sentence that says
// what connecting gives you, then the verb that starts it. The quiet sibling of SettingsEmpty for
// a group whose whole content is "connect this first". Leave the action out for someone who
// cannot connect it.
export function ConnectPrompt({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 py-1">
      <p className="text-sm text-pretty text-muted-foreground">{children}</p>
      {action}
    </div>
  )
}

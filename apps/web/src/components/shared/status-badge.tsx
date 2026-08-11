import type { ComponentPropsWithoutRef } from "react"
import { Badge } from "@/components/ui/badge"

// One vocabulary for state chips, keyed by MEANING so the same state can't wear
// different clothes in different sections ("Pending" was outline in Members and
// warning in Domains). Pick the tone by semantics, never by color:
//   ok        — confirmed good; a quiet success (delivered, active)
//   attention — waiting on YOU; act here (DNS pending, needs sign-in)
//   error     — failed, or gave up retrying (dead, error)
//   busy      — in flight right now (running, syncing)
//   muted     — dormant, or waiting on someone else (paused, an invite pending)
// Status hues are signals: never reuse them as decoration. Busy borrows the
// brand tint deliberately — in-flight is a brand moment (StatusPanel's grammar),
// not a judgment; the other four are judgments.
export const STATUS_TONE_VARIANT = {
  ok: "success",
  attention: "warning",
  error: "destructive",
  busy: "brand",
  muted: "outline",
} as const

export type StatusTone = keyof typeof STATUS_TONE_VARIANT

export function StatusBadge({
  tone,
  ...rest
}: { tone: StatusTone } & ComponentPropsWithoutRef<typeof Badge>) {
  return <Badge variant={STATUS_TONE_VARIANT[tone]} {...rest} />
}

import { useState } from "react"
import { cn } from "@/lib/utils"

// Minimal transient toast. Inverted (foreground bg / background text) so it
// reads on any theme. Returns the element to render + a `show(msg)` trigger.
export function useToast() {
  const [msg, setMsg] = useState("")
  const toast = (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "pointer-events-none fixed bottom-[18px] left-1/2 z-[90] -translate-x-1/2 rounded-[10px] bg-foreground px-[15px] py-2.5 text-sm text-background transition-opacity duration-200",
        msg ? "opacity-100" : "opacity-0",
      )}
    >
      {msg}
    </div>
  )
  const show = (m: string) => {
    setMsg(m)
    setTimeout(() => setMsg(""), 1900)
  }
  return { toast, show }
}

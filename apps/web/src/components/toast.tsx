import { useCallback, useRef, useState } from "react"
import { cn } from "@/lib/utils"

type ToastKind = "info" | "error"
interface ToastItem {
  id: number
  msg: string
  kind: ToastKind
}

// How long each kind lingers before auto-dismiss. Errors stay long enough to
// read and act on; info is a quick confirmation.
const TIMEOUT_MS: Record<ToastKind, number> = { info: 2200, error: 6000 }

// Transient toast stack. Multiple rapid calls queue and stack instead of
// clobbering a single slot — the old single-`msg` version dropped every toast
// but the last (publish-then-copy would lose the first message). Each toast
// owns its own dismiss timer. Info is inverted (foreground bg) so it reads on
// any theme; error uses the destructive token and announces assertively.
// Returns the element to render + a `show(msg, kind?)` trigger; existing
// `show(msg)` callers are unchanged (kind defaults to "info").
export function useToast() {
  const [items, setItems] = useState<ToastItem[]>([])
  const seq = useRef(0)
  const show = useCallback((msg: string, kind: ToastKind = "info") => {
    const id = ++seq.current
    setItems((prev) => [...prev, { id, msg, kind }])
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), TIMEOUT_MS[kind])
  }, [])
  // The container is always mounted so the live regions exist before any text
  // lands in them; toasts are inserted as children as they fire.
  const toast = (
    <div className="pointer-events-none fixed bottom-[18px] left-1/2 z-[90] flex -translate-x-1/2 flex-col items-center gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          aria-live={t.kind === "error" ? "assertive" : "polite"}
          className={cn(
            "rounded-[10px] px-[15px] py-2.5 text-sm shadow-lg",
            t.kind === "error"
              ? "bg-destructive text-destructive-foreground"
              : "bg-foreground text-background",
          )}
        >
          {t.msg}
        </div>
      ))}
    </div>
  )
  return { toast, show }
}

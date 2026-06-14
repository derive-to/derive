import * as PopoverPrimitive from "@radix-ui/react-popover"
import type * as React from "react"
import { useEffect } from "react"
import { cn } from "@/lib/utils"

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor

// Radix dismisses a popover on a pointerdown outside it, but a click that lands
// inside the artifact <iframe> never reaches this document (the iframe swallows
// it), so the popover would stay open. When focus jumps into an iframe the window
// fires `blur`; translate that into a synthetic outside pointerdown so Radix's own
// dismissal runs. Fixes "click the artifact to dismiss the cursor/notification popover."
function useDismissOnIframeBlur() {
  useEffect(() => {
    const onBlur = () => {
      // activeElement settles to the iframe just after the blur event fires.
      setTimeout(() => {
        if (document.activeElement instanceof HTMLIFrameElement)
          document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
      }, 0)
    }
    window.addEventListener("blur", onBlur)
    return () => window.removeEventListener("blur", onBlur)
  }, [])
}

export function PopoverContent({
  className,
  align = "end",
  sideOffset = 7,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  useDismissOnIframeBlur()
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-[var(--shadow)] outline-none",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

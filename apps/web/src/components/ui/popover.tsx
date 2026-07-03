import { Popover as PopoverPrimitive } from "radix-ui"
import * as React from "react"

import { cn } from "@/lib/utils"

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

// derive fix (the ONLY delta from stock): Radix dismisses on an outside
// pointerdown, but a click inside the artifact <iframe> never reaches this
// document — and DismissableLayer ignores a synthetically replayed pointerdown —
// so while the content is open, an iframe stealing focus (a click into an
// iframe fires window `blur`) programmatically clicks a hidden Popover.Close.
// Radix runs its own close path, so controlled callers get onOpenChange(false).
function IframeBlurClose() {
  const ref = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    const onBlur = () => {
      // Defer: activeElement settles after the blur event.
      setTimeout(() => {
        if (document.activeElement instanceof HTMLIFrameElement) ref.current?.click()
      }, 0)
    }
    window.addEventListener("blur", onBlur)
    return () => window.removeEventListener("blur", onBlur)
  }, [])
  return <PopoverPrimitive.Close ref={ref} className="hidden" tabIndex={-1} aria-hidden="true" />
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  collisionPadding = 8,
  children,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      {/* Floating surface recipe: popover step + hairline ring; the shadow var
          is zeroed in dark (elevation there = surface step + edge). */}
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "z-50 flex w-72 origin-(--radix-popover-content-transform-origin) flex-col gap-3 rounded-xl bg-popover p-3 text-sm text-popover-foreground shadow-[var(--shadow-pop)] ring-1 ring-foreground/10 outline-hidden duration-200 ease-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      >
        {children}
        <IframeBlurClose />
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  )
}

function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-0.5 text-sm", className)}
      {...props}
    />
  )
}

function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      data-slot="popover-title"
      className={cn("font-medium text-balance", className)}
      {...props}
    />
  )
}

function PopoverDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="popover-description"
      className={cn("text-pretty text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
}

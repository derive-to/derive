import { ChevronDownIcon } from "lucide-react"
import type * as React from "react"
import { createContext, use } from "react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

// A Select-alike for pickers that live inside a Dialog. Radix's real Select
// unconditionally disables outside pointer events on its content
// (@radix-ui/react-select has no `modal` escape hatch), which cascades a
// `pointer-events: none` onto every layer beneath it — including a host
// Dialog's own content. The next click anywhere in the dialog that isn't the
// select's own popup then hits the Dialog's overlay instead and dismisses it.
// DropdownMenu's non-modal mode (the default posture here) never disables
// outside pointer events, so it composes cleanly inside a modal Dialog. Same
// trigger/content recipe as ui/select.tsx, minus the parts (native form
// fallback, item-aligned positioning) that don't apply to a menu.

const SelectMenuContext = createContext<{
  value: string
  onValueChange: (value: string) => void
} | null>(null)

function SelectMenu({
  value,
  onValueChange,
  children,
}: {
  value: string
  onValueChange: (value: string) => void
  children: React.ReactNode
}) {
  return (
    <SelectMenuContext.Provider value={{ value, onValueChange }}>
      <DropdownMenu modal={false}>{children}</DropdownMenu>
    </SelectMenuContext.Provider>
  )
}

function SelectMenuTrigger({
  className,
  disabled,
  children,
  ...props
}: React.ComponentProps<"button">) {
  return (
    <DropdownMenuTrigger asChild>
      <button
        {...props}
        type="button"
        disabled={disabled}
        className={cn(
          "flex h-8 w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap shadow-(--shadow-sm) outline-none select-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 dark:bg-input/30 dark:disabled:bg-input/80 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          className,
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">{children}</span>
        <ChevronDownIcon className="text-muted-foreground" />
      </button>
    </DropdownMenuTrigger>
  )
}

function SelectMenuContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
  const ctx = use(SelectMenuContext)
  if (!ctx) throw new Error("SelectMenuContent must be used within SelectMenu")
  return (
    <DropdownMenuContent
      className={cn("min-w-(--radix-popper-anchor-width)", className)}
      {...props}
    >
      <DropdownMenuRadioGroup value={ctx.value} onValueChange={ctx.onValueChange}>
        {children}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  )
}

function SelectMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuRadioItem>) {
  return <DropdownMenuRadioItem className={cn("py-1.5 pr-8 pl-2", className)} {...props} />
}

// A visual break between option groups (radio semantics are unaffected).
const SelectMenuSeparator = DropdownMenuSeparator

export { SelectMenu, SelectMenuContent, SelectMenuItem, SelectMenuSeparator, SelectMenuTrigger }

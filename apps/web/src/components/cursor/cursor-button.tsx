import { Eyebrow } from "@/components/shared/section-eyebrow"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useCursorPref } from "@/ctx"
import { CursorSwitch } from "./cursor-switch"
import { CursorGlyph } from "./glyph"

// A compact "your cursor" control for the artifact bar: shows your current
// glyph and opens the picker. This is the entry point that works for anonymous
// public-link viewers (who never see the account pod), so anyone can customize.
export function CursorButton() {
  const { pref } = useCursorPref()
  return (
    <Popover>
      {/* No Tooltip layer: TooltipTrigger + PopoverTrigger asChild on one
          button loops radix's composed refs (verified in e2e). aria-label
          carries the name; the popover itself is the explanation. */}
      <PopoverTrigger asChild>
        {/* Glyph at 14 to match the icon-xs register (the button sizes svgs to
            3.5 anyway; the emoji branch follows suit via fontSize). */}
        <Button
          variant="ghost"
          size="icon-xs"
          data-testid="cursor-self-trigger"
          aria-label="Customize your cursor"
          className="text-muted-foreground"
        >
          <CursorGlyph color={pref.color} kind={pref.kind} emoji={pref.emoji} size={14} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 gap-0 p-2">
        <Eyebrow as="div" className="px-0.5 pb-1.5">
          Your cursor
        </Eyebrow>
        <CursorSwitch />
      </PopoverContent>
    </Popover>
  )
}

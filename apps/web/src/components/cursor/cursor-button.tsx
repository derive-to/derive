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
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="cursor-self-trigger"
          title="Customize your cursor"
          aria-label="Customize your cursor"
          className="grid size-[26px] place-items-center rounded-md text-muted-foreground transition-colors hover:bg-hover"
        >
          <CursorGlyph color={pref.color} kind={pref.kind} emoji={pref.emoji} size={16} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-2">
        <div className="px-0.5 pb-1.5 font-mono text-2xs uppercase tracking-[0.06em] text-muted-foreground">
          Your cursor
        </div>
        <CursorSwitch />
      </PopoverContent>
    </Popover>
  )
}

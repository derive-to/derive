import { useRef } from "react"
import { Icon } from "@/components/icons"
import { Spinner } from "@/components/shared/spinner"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Kbd } from "@/components/ui/kbd"
import { cn } from "@/lib/utils"

// The house search/filter field — ONE anatomy for every list filter and people/
// content search: search-icon scent, scoped placeholder, in-field spinner while
// an async lookup is in flight, a single cross-browser clear (the native WebKit
// cancel glyph is suppressed), and Esc that clears first, blurs second.
//
// Placeholder grammar: instant client-side narrowing says "Filter …"; server
// discovery says "Search …". The global command palette (⌘K) is the only other
// search surface.
//
// `hotkey` marks this field as the page's "/" target (at most one per page):
// app-shell's global "/" handler focuses it — and falls back to opening the
// command palette on pages without one. The Kbd hint advertises it while the
// field is empty.
export function SearchField({
  value,
  onValueChange,
  placeholder,
  hotkey = false,
  loading = false,
  autoFocus = false,
  className,
  testId,
  onEnter,
  onAsk,
  "aria-label": ariaLabel,
}: {
  value: string
  onValueChange: (value: string) => void
  placeholder: string
  /** Register this field as the page's "/" focus target (one per page). */
  hotkey?: boolean
  /** An async search is in flight — swaps the scent icon for the spinner. */
  loading?: boolean
  autoFocus?: boolean
  className?: string
  testId: string
  /** Fired on Enter with the current value trimmed non-empty — e.g. to submit to a results page. */
  onEnter?: (value: string) => void
  /** Fired on ⌘↵ / Ctrl+↵, empty value included: ask the agent what is in the box instead of
   *  searching for it. The keyboard half of the Ask button beside the field
   *  (shared/ask-button), and the same gesture the ⌘K palette uses, so the shortcut means one
   *  thing everywhere it exists. */
  onAsk?: (value: string) => void
  "aria-label": string
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <InputGroup className={className}>
      <InputGroupAddon>
        {loading ? <Spinner size="sm" /> : <Icon name="search" className="text-muted-foreground" />}
      </InputGroupAddon>
      <InputGroupInput
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          // ⌘↵ before ↵: the modifier is the whole difference between asking and searching, so
          // it has to be read first or a held ⌘ still submits a search.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && onAsk) {
            e.preventDefault()
            onAsk(value.trim())
            return
          }
          if (e.key === "Enter") {
            const v = value.trim()
            if (onEnter && v) onEnter(v)
            return
          }
          if (e.key !== "Escape") return
          if (value) {
            // First Esc clears; inside a dialog, closing stays the second Esc.
            e.preventDefault()
            e.stopPropagation()
            onValueChange("")
          } else {
            e.currentTarget.blur()
          }
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-keyshortcuts={hotkey ? "/" : undefined}
        data-slash-target={hotkey ? "" : undefined}
        data-testid={testId}
        autoFocus={autoFocus}
        className="[&::-webkit-search-cancel-button]:appearance-none"
      />
      <InputGroupAddon align="inline-end" className={cn(!value && !hotkey && "hidden")}>
        {value ? (
          <InputGroupButton
            size="icon-xs"
            aria-label="Clear search"
            data-testid={`${testId}-clear`}
            onClick={() => {
              onValueChange("")
              inputRef.current?.focus()
            }}
          >
            <Icon name="close" className="size-3 text-muted-foreground" />
          </InputGroupButton>
        ) : (
          <Kbd className="max-sm:hidden">/</Kbd>
        )}
      </InputGroupAddon>
    </InputGroup>
  )
}

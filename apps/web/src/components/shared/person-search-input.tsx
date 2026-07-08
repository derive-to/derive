import { useEffect, useRef, useState } from "react"
import { api, type PublicProfile } from "@/api"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Input } from "@/components/ui/input"
import { getInitials } from "@/lib/initials"
import { cn } from "@/lib/utils"

// A GitHub-style @handle typeahead for "add a person by username or email":
// debounced discoverable-people search, arrow-key highlight, Enter picks the
// highlighted suggestion — or, with nothing highlighted, falls through to the
// enclosing <form>'s submit (so a non-discoverable person stays addable by
// typing their exact @handle/email and hitting Add/Enter). Render inside a
// <form onSubmit={...}> and wire the Add button yourself; this owns only the
// input + suggestion popover. Mirrors the artifact ShareDialog's own (hand-
// rolled, duplicated) typeahead — extracted here so a third copy doesn't happen.
export function PersonSearchInput({
  value,
  onChange,
  placeholder = "Add people by @username or email…",
  ariaLabel = "Username or email",
  testId = "person-search",
  className,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  ariaLabel?: string
  /** Prefixes every data-testid/element id this renders — keep unique per surface. */
  testId?: string
  className?: string
}) {
  const [suggest, setSuggest] = useState<PublicProfile[]>([])
  const [active, setActive] = useState(-1)
  // The value we just picked, so the follow-up search for it doesn't reopen the menu.
  const picked = useRef("")

  useEffect(() => {
    const term = value.trim()
    if (!term || term === picked.current) {
      setSuggest([])
      return
    }
    let alive = true
    const t = setTimeout(() => {
      api
        .searchPeople(term)
        .then((r) => {
          if (alive) {
            setSuggest(r.users)
            setActive(-1)
          }
        })
        .catch(() => alive && setSuggest([]))
    }, 180)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [value])

  const pick = (u: PublicProfile) => {
    picked.current = `@${u.username}`
    onChange(`@${u.username}`)
    setSuggest([])
    setActive(-1)
  }
  // ↑/↓ to move, Enter to pick the highlighted suggestion, Esc to close the menu.
  // With no highlight, Enter falls through to the form submit (free-text add).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (suggest.length === 0) return
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, suggest.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, -1))
    } else if (e.key === "Enter" && active >= 0 && suggest[active]) {
      e.preventDefault()
      pick(suggest[active])
    } else if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      setSuggest([])
    }
  }

  return (
    <div className={cn("relative flex-1", className)}>
      {/* WAI-APG combobox wiring: the input announces the popup and the
          arrow-key highlight (aria-activedescendant). */}
      <Input
        data-testid={testId}
        type="text"
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        placeholder={placeholder}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={suggest.length > 0}
        aria-autocomplete="list"
        aria-controls={`${testId}-list`}
        aria-activedescendant={
          active >= 0 && suggest[active] ? `${testId}-opt-${active}` : undefined
        }
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        className="w-full"
      />
      {suggest.length > 0 && (
        <div
          data-testid={`${testId}-suggest`}
          id={`${testId}-list`}
          role="listbox"
          aria-label="People suggestions"
          className="absolute inset-x-0 top-[calc(100%+4px)] z-40 max-h-56 overflow-y-auto rounded-xl bg-popover p-1 shadow-[var(--shadow-pop)] ring-1 ring-foreground/10"
        >
          {suggest.map((u, i) => (
            <button
              key={u.username}
              type="button"
              data-testid={`${testId}-suggest-item`}
              id={`${testId}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              // Keep the input focused so the click registers without blurring first.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(u)}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                i === active ? "bg-accent" : "hover:bg-accent",
              )}
            >
              <Avatar className="size-6">
                {u.image && <AvatarImage src={u.image} alt={u.name ?? u.username} />}
                <AvatarFallback>{getInitials(u.name ?? u.username)}</AvatarFallback>
              </Avatar>
              <span className="min-w-0 flex-1">
                {u.name && (
                  <span className="block truncate text-sm font-medium text-foreground">
                    {u.name}
                  </span>
                )}
                <span className="block truncate font-mono text-2xs text-muted-foreground">
                  @{u.username}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

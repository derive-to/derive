import { cn } from "@/lib/utils"

// Documents ⇄ Collections. Two states, one control — the shelves used to be an
// unbounded list in the navigation, which grew until the rail was a file browser.
// They are a view of the library instead, because a collection is a place you go, not
// a permanent thing to scroll past.
export function ViewSwitch({
  value,
  onChange,
}: {
  value: "documents" | "collections"
  onChange: (next: "documents" | "collections") => void
}) {
  return (
    <div
      role="tablist"
      aria-label="Library view"
      className="inline-flex h-8 shrink-0 items-center rounded-lg border p-0.5"
    >
      {(["documents", "collections"] as const).map((v) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={value === v}
          data-testid={`library-view-${v}`}
          onClick={() => onChange(v)}
          className={cn(
            "rounded-md px-2.5 py-1 text-sm font-medium capitalize outline-none",
            "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
            // Selected is a neutral wash with re-inked text — never a tint, and the
            // weight does not change between states (the nav rule, so the control
            // doesn't reflow as you switch).
            value === v
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {v}
        </button>
      ))}
    </div>
  )
}

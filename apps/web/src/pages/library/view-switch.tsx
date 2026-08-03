import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

export type LibraryViewMode = "artifacts" | "collections"

// Artifacts ⇄ Collections, as underline tabs beneath the page's name — they are views
// of one place, which is what tabs say. The boxed segmented control fought the search
// box for the toolbar's attention; tabs sit where Linear puts them, small and quiet.
//
// Still ToggleGroup (Radix owns roving focus and pressed state; a tablist without
// tabpanels is a half-implemented ARIA pattern) — only the clothes changed.
export function ViewSwitch({
  value,
  onChange,
}: {
  value: LibraryViewMode
  onChange: (next: LibraryViewMode) => void
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      // Radix emits "" when you press the active segment; ignore it so the library
      // always has a view rather than flickering to neither.
      onValueChange={(v) => v && onChange(v as LibraryViewMode)}
      aria-label="Library view"
      data-testid="library-view"
      className="gap-5"
    >
      <ToggleGroupItem
        value="artifacts"
        data-testid="library-view-artifacts"
        className="relative h-9 rounded-none bg-transparent px-0.5 text-sm text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-transparent data-[state=on]:text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full data-[state=on]:after:bg-foreground"
      >
        Artifacts
      </ToggleGroupItem>
      <ToggleGroupItem
        value="collections"
        data-testid="library-view-collections"
        className="relative h-9 rounded-none bg-transparent px-0.5 text-sm text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-transparent data-[state=on]:text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full data-[state=on]:after:bg-foreground"
      >
        Collections
      </ToggleGroupItem>
    </ToggleGroup>
  )
}

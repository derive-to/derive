import { Icon } from "@/components/icons"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

export type LibraryViewMode = "documents" | "collections"

// Documents ⇄ Collections. Shelves were an unbounded list in the rail; they are a view
// of the library instead.
//
// Built on ToggleGroup like the other segmented controls (access, billing cycle) rather
// than a hand-rolled tablist — Radix owns the roving focus and pressed state, and a
// tablist without tabpanels is a half-implemented ARIA pattern.
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
      className="h-8 shrink-0 gap-[3px] rounded-lg bg-secondary p-[3px]"
    >
      <ToggleGroupItem
        value="documents"
        data-testid="library-view-documents"
        className="h-full gap-1.5 rounded-md px-2.5 text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-(--shadow-sm)"
      >
        <Icon name="all" size={16} />
        Documents
      </ToggleGroupItem>
      <ToggleGroupItem
        value="collections"
        data-testid="library-view-collections"
        className="h-full gap-1.5 rounded-md px-2.5 text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-(--shadow-sm)"
      >
        <Icon name="collections" size={16} />
        Collections
      </ToggleGroupItem>
    </ToggleGroup>
  )
}

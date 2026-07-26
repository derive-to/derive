import { Icon, type IconName } from "@/components/icons"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

// The "who can open this" segmented control both the artifact ShareDialog and the
// collection ShareDialog open with — same shape (a ToggleGroup of icon + label
// segments, applies immediately, no Save), different segment lists (an artifact
// adds Anyone; a collection stops at Invited/Workspace since it isn't
// individually link-servable content). Pulled out so the two dialogs can't drift
// on this shared piece — a style tweak here reaches both.
export function AccessSegmentToggle<T extends string>({
  segments,
  value,
  onChange,
  disabled,
  testId,
}: {
  segments: { value: T; label: string; icon: IconName }[]
  value: T
  onChange: (next: T) => void
  disabled?: boolean
  testId: string
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as T)}
      data-testid={testId}
      className="w-full gap-[3px] rounded-lg bg-secondary p-[3px]"
    >
      {segments.map((s) => (
        <ToggleGroupItem
          key={s.value}
          value={s.value}
          disabled={disabled}
          data-testid={`${testId}-${s.value}`}
          className="h-8 flex-1 gap-1.5 rounded-md text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-(--shadow-sm)"
        >
          <Icon name={s.icon} />
          {s.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

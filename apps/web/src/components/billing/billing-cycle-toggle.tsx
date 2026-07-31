import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

/** The Monthly/Annual switch, shared by the billing page and the paywall dialog so
 *  the markup can't drift between them. `testIdPrefix` scopes each surface's own
 *  testids: the group gets `testIdPrefix` itself, the items `${testIdPrefix}-month`
 *  / `${testIdPrefix}-year`. */
export function BillingCycleToggle({
  value,
  onChange,
  testIdPrefix,
}: {
  value: "month" | "year"
  onChange: (value: "month" | "year") => void
  testIdPrefix: string
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as "month" | "year")}
      data-testid={testIdPrefix}
      className="gap-[3px] rounded-lg bg-secondary p-[3px]"
    >
      <ToggleGroupItem
        value="month"
        data-testid={`${testIdPrefix}-month`}
        className="rounded-md text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-(--shadow-sm)"
      >
        Monthly
      </ToggleGroupItem>
      <ToggleGroupItem
        value="year"
        data-testid={`${testIdPrefix}-year`}
        className="rounded-md text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-(--shadow-sm)"
      >
        Annual
      </ToggleGroupItem>
    </ToggleGroup>
  )
}

import type { ReactNode } from "react"
import { Icon, type IconName } from "@/components/icons"
import { SectionHeading } from "@/components/shared/section-title"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import type { MachineMark } from "./format"

// Shared agent rows: a state glyph, a title and detail, then quiet metadata.

export function Group({
  label,
  testId,
  children,
}: {
  /** Omitted where the page title already names the list. */
  label?: string
  testId: string
  children: ReactNode
}) {
  return (
    <section data-testid={testId} className="flex flex-col">
      {label && <SectionHeading className="mb-3">{label}</SectionHeading>}
      <div className="flex flex-col">{children}</div>
    </section>
  )
}

/** The row's inner line. The caller supplies the element (a Link, a button, a div). */
export function RowLine({
  icon,
  tone,
  title,
  detail,
}: {
  icon: IconName
  tone?: "warning" | "destructive"
  title: ReactNode
  detail?: ReactNode
}) {
  return (
    <>
      <Icon
        name={icon}
        size={16}
        strokeWidth={1.75}
        className={cn(
          "text-muted-foreground",
          tone === "warning" && "text-warning",
          tone === "destructive" && "text-destructive",
          icon === "job-running" && "motion-safe:animate-spin",
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1 overflow-hidden">
        <span className="truncate font-medium text-foreground">{title}</span>
        {detail && (
          <span
            className={cn(
              "w-full truncate text-sm text-muted-foreground",
              tone === "warning" && "text-foreground",
            )}
          >
            {detail}
          </span>
        )}
      </span>
    </>
  )
}

/** Row spacing and separators. A row that needs someone says so with its icon and words, not
 *  a wash of colour. */
export const rowClass = () =>
  "flex min-h-18 items-center gap-3.5 border-b border-border py-3 text-base last:border-b-0 hover:bg-secondary/40"

/** The right-hand cluster: small grey words, times in mono. */
export function Meta({ children }: { children: ReactNode }) {
  return (
    <span className="flex shrink-0 items-center gap-5 text-sm text-muted-foreground max-sm:gap-3">
      {children}
    </span>
  )
}

export const Time = ({ children, title }: { children: ReactNode; title?: string }) => (
  <span className="font-mono" title={title}>
    {children}
  </span>
)

/** Where it runs, with a filled dot when that machine is answering and a hollow one when not. */
export function Machine({ mark }: { mark: MachineMark }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          mark.on ? "bg-success" : "border border-muted-foreground",
        )}
      />
      {mark.label}
    </span>
  )
}

/** A small choice of two or three: visible options, never a dropdown. */
export function Segmented({
  testId,
  value,
  options,
  onChange,
  disabled,
}: {
  testId: string
  value: string
  options: { value: string; label: string; disabled?: boolean }[]
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => v && v !== value && onChange(v)}
      data-testid={testId}
      className="w-fit gap-0.5 rounded-lg bg-secondary p-0.5"
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o.value}
          value={o.value}
          disabled={disabled || o.disabled}
          data-testid={`${testId}-${o.value}`}
          className="h-7 rounded-md px-3 text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-(--shadow-sm)"
        >
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

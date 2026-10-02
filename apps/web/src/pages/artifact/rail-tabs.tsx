import { cn } from "@/lib/utils"

/** The small, shared vocabulary for the artifact's one right rail. Activity (the key is
 * still "comments": every caller and deep link speaks it) must remain first: it is the
 * default reading companion, the one stream of threads and changes. Inspect is optional per
 * artifact and role; it never becomes a parallel primary surface. Ask (ask-panel.tsx) is a
 * private conversation, kept out of the shared stream: on a desktop the top bar's Ask button
 * opens it, so the strip there never lists it; on a phone the sheet's strip is the only way
 * in, so it is the strip's last tab. */
export type RailTab = "comments" | "data" | "references" | "inspect" | "ask"

const RAIL_LABEL: Record<RailTab, string> = {
  comments: "Activity",
  data: "Data",
  references: "References",
  inspect: "Inspect",
  ask: "Ask",
}

/** The rail's tab strip. It stays a handful of buttons rather than a full Tabs primitive: it
 * must fit inline in the existing desktop header and mobile peek bar. The capability gates are
 * explicit here so every consumer renders the exact same order. */
export function RailTabs(props: {
  tab: RailTab
  commentCount: number
  onTab: (t: RailTab) => void
  /** The version binds dynamic tables or figures: show the Data tab. */
  dataEnabled?: boolean
  /** A paper bundle with a .bib: show the References tab. */
  referencesEnabled?: boolean
  inspectEnabled?: boolean
  /** The phone sheet's strip: list Ask, when there is someone to ask. */
  askEnabled?: boolean
}) {
  const {
    tab,
    commentCount,
    onTab,
    dataEnabled = false,
    referencesEnabled = false,
    inspectEnabled = false,
    askEnabled = false,
  } = props
  const tabs: RailTab[] = [
    "comments",
    ...(dataEnabled ? (["data"] as const) : []),
    ...(referencesEnabled ? (["references"] as const) : []),
    ...(inspectEnabled ? (["inspect"] as const) : []),
    ...(askEnabled ? (["ask"] as const) : []),
  ]
  return (
    <div className="flex items-center gap-1" data-testid="rail-tabs">
      {tabs.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onTab(t)}
          aria-pressed={tab === t}
          className={cn(
            "rounded-md px-2 py-1 text-sm font-medium",
            tab === t ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
          data-testid={`rail-tab-${t}`}
        >
          {RAIL_LABEL[t]}
          {t === "comments" && commentCount > 0 ? (
            <span className="ml-1 text-xs text-muted-foreground">{commentCount}</span>
          ) : null}
        </button>
      ))}
    </div>
  )
}

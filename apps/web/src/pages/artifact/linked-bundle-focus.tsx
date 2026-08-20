import { useMemo, useState } from "react"
import type { Artifact } from "@/api"
import { Icon } from "@/components/icons"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

type LinkedBundle = NonNullable<Artifact["linked_bundle"]>
type Diagram = NonNullable<LinkedBundle["diagrams"]>[number]
type Member = LinkedBundle["members"][number]

export type LinkedBundleFocusTarget = {
  key: string
  diagram: string
  local: string
  label: string
  context: string
  search: string
}

export const linkedBundleFocusTargets = (
  diagrams: Diagram[],
  members: Map<string, Member>,
): LinkedBundleFocusTarget[] =>
  diagrams.flatMap((diagram) =>
    diagram.nodes.map((node) => {
      const member = node.member ? members.get(node.member) : undefined
      const context = [diagram.title, member?.label].filter(Boolean).join(" · ")
      return {
        key: `${diagram.id}:${node.id}`,
        diagram: diagram.id,
        local: node.id,
        label: node.label,
        context,
        search: `${node.label} ${diagram.title} ${member?.label ?? ""}`.toLowerCase(),
      }
    }),
  )

export const linkedBundleFocusMatches = (
  targets: LinkedBundleFocusTarget[],
  query: string,
): LinkedBundleFocusTarget[] => {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  return targets.filter((target) => terms.every((term) => target.search.includes(term))).slice(0, 6)
}

export function LinkedBundleFocusSearch({
  diagrams,
  members,
  onFocus,
}: {
  diagrams: Diagram[]
  members: Map<string, Member>
  onFocus: (target: LinkedBundleFocusTarget) => void
}) {
  const [query, setQuery] = useState("")
  const targets = useMemo(() => linkedBundleFocusTargets(diagrams, members), [diagrams, members])
  const results = useMemo(() => linkedBundleFocusMatches(targets, query), [query, targets])

  return (
    <div className="relative w-full sm:w-72" data-testid="bundle-focus-search">
      <Icon
        name="search"
        size={14}
        className="pointer-events-none absolute left-2.5 top-1/2 z-10 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        data-testid="bundle-focus-query"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setQuery("")
          if (event.key === "Enter" && results[0]) {
            onFocus(results[0])
            setQuery("")
          }
        }}
        className="h-8 bg-card pl-8 text-xs"
        placeholder="Find node or artifact…"
        aria-label="Find a loop or graph node"
      />
      {query.trim() ? (
        <div className="absolute left-0 right-0 top-9 z-50 overflow-hidden rounded-lg border border-border bg-popover shadow-xl">
          {results.length ? (
            results.map((target, index) => (
              <button
                key={target.key}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onFocus(target)
                  setQuery("")
                }}
                className={cn(
                  "block w-full px-3 py-2 text-left hover:bg-muted",
                  index > 0 && "border-t border-border-soft",
                )}
                data-testid={`bundle-focus-result-${target.key}`}
              >
                <span className="block truncate text-xs font-medium text-foreground">
                  {target.label}
                </span>
                <span className="mt-0.5 block truncate text-2xs text-muted-foreground">
                  {target.context}
                </span>
              </button>
            ))
          ) : (
            <div className="px-3 py-2 text-xs text-muted-foreground">No matching node.</div>
          )}
        </div>
      ) : null}
    </div>
  )
}

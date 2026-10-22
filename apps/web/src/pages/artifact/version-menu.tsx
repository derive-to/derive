import { Link } from "@tanstack/react-router"
import type { Artifact } from "@/api"
import { Icon } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { stamp } from "@/lib/time"
import { cn } from "@/lib/utils"

type Version = NonNullable<Artifact["versions"]>[number]

/** The version label in a page's state line, as a menu: every version, one line each,
 *  newest first, with when it was published and by whom. With one version there is
 *  nothing to pick, so it stays the inert text. Items navigate either through the
 *  caller's `onPick` (the signed-in page) or as links to the @vN refs (the public
 *  viewer, where a plain anchor is what a crawler and a middle-click expect). */
export function VersionMenu({
  versions,
  shown,
  current,
  testPrefix,
  onPick,
  linkFor,
}: {
  versions: Version[]
  shown: number
  current: number
  testPrefix: string
  onPick?: (n: number) => void
  linkFor?: (n: number) => { to: "/artifacts/$ref" | "/templates/$ref"; params: { ref: string } }
}) {
  if (versions.length <= 1) return <>v{shown}</>
  const rows = [...versions].sort((a, b) => b.n - a.n)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid={`${testPrefix}-version-menu`}
        aria-label={`Version ${shown} of ${current}. Pick a version.`}
        className="inline-flex items-center gap-0.5 rounded-sm text-foreground outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        v{shown}
        <Icon name="caret" size={12} className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-80 min-w-64 max-w-[420px] overflow-y-auto"
      >
        {rows.map((v) => {
          const body = (
            <>
              <span
                className={cn(
                  "w-8 shrink-0 font-mono text-xs tabular-nums",
                  v.n === shown ? "font-semibold text-foreground" : "text-muted-foreground",
                )}
              >
                v{v.n}
              </span>
              <span className="shrink-0 text-xs text-foreground tabular-nums">
                {v.created_at ? stamp(v.created_at) : ""}
              </span>
              {v.author && (
                <span className="truncate text-xs text-muted-foreground">{v.author}</span>
              )}
              {v.n === current && (
                <Badge shape="pill" variant="brand" className="ml-auto shrink-0">
                  current
                </Badge>
              )}
            </>
          )
          const cls = "flex w-full min-w-0 items-center gap-2"
          return linkFor ? (
            <DropdownMenuItem key={v.n} asChild data-testid={`${testPrefix}-version-${v.n}`}>
              <Link {...linkFor(v.n)} className={cls}>
                {body}
              </Link>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              key={v.n}
              data-testid={`${testPrefix}-version-${v.n}`}
              className={cls}
              onSelect={() => onPick?.(v.n)}
            >
              {body}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

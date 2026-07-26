import { Link } from "@tanstack/react-router"
import type { Artifact } from "@/api"
import { Icon } from "@/components/icons"
import { Thumb } from "@/components/shared/thumb"
import { Badge } from "@/components/ui/badge"
import { artifactTypeLabel, dirOf } from "@/lib/artifact"
import { ago } from "@/lib/time"
import { refFor } from "../artifact/parse-ref"

// A views chip (mono meta), shown only when an artifact has viewers. Shared by the
// card + row so the two read identically.
function Views({ n }: { n: number }) {
  return (
    <span className="inline-flex items-center gap-1 tabular-nums" title={`${n} viewers`}>
      <Icon name="views" size={12} />
      {n > 999 ? `${(n / 1000).toFixed(1)}k` : n}
      <span className="sr-only"> views</span>
    </span>
  )
}

// One piece of a person's work on their profile, GRID form. A focused, link-first card
// (no favorite/delete chrome — those are library affordances): thumbnail, title, type +
// updated + views. The whole card is the link, so it preloads on hover and opens the
// artifact. Mirrors the library card's look so the two read as one design.
export function ProfileWorkCard({ artifact: a }: { artifact: Artifact }) {
  const updated = a.updated_at ?? a.created_at ?? a.versions[0]?.created_at
  const dir = a.source_path ? dirOf(a.source_path) : ""
  const versionDepth = Math.max(a.current_version, a.versions.length)
  // Machine-register state line, house " · " join — a synced file's folder, else its
  // version when there's history, then freshness. The TYPE rides the placard.
  const stateLine = [
    dir ? `${dir}/` : versionDepth > 1 ? `v${a.current_version}` : "",
    updated ? `updated ${ago(updated)}` : "",
  ]
    .filter(Boolean)
    .join(" · ")
  return (
    <Link
      to="/artifacts/$ref"
      params={{ ref: refFor(a) }}
      data-testid={`profile-work-${a.short_id}`}
      // Interactive card, mirroring the library card exactly: a resting soft shadow
      // (zeroed in dark by the theme token) carries light-mode lift; hover is an
      // instant hairline-brighten only — no shadow transition (a lifting shadow
      // isn't a sanctioned move/scale/fade, and it would repaint the Thumb iframe).
      className="group flex flex-col overflow-hidden rounded-xl border bg-card shadow-(--shadow-sm) outline-none hover:border-foreground/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <Thumb
        id={a.short_id}
        v={a.current_version}
        typeLabel={artifactTypeLabel(a)}
        hasPreview={a.has_preview}
      />
      <div className="flex min-w-0 flex-col gap-2 border-t border-border-soft p-3.5">
        {/* The artifact title is the work — Geist voice, sized to the caption. */}
        <span className="truncate font-serif text-base font-medium tracking-tight text-foreground">
          {a.title ?? a.short_id}
        </span>
        {/* Machine-register state line, mirroring ArtifactCard (minus the library-only
            author/review chrome), with any view count trailing right. */}
        <span className="flex min-w-0 items-center gap-2 font-mono text-2xs tabular-nums text-muted-foreground">
          {stateLine && (
            <span className="truncate" title={dir ? (a.source_path ?? undefined) : undefined}>
              {stateLine}
            </span>
          )}
          {a.views !== undefined && a.views > 0 && (
            <span className="ml-auto shrink-0">
              <Views n={a.views} />
            </span>
          )}
        </span>
      </div>
    </Link>
  )
}

// The same work, LIST form — a compact link row for scanning a prolific profile by
// title (the grid/list toggle's other half). Link-first like the card; a leading
// machine-register type chip, the title in voice, then updated + views as a mono meta
// tail. Bordered rows (mirroring the library's ArtifactRow) so the two surfaces read as
// one design, minus the library-only star/delete/author chrome.
export function ProfileWorkRow({ artifact: a }: { artifact: Artifact }) {
  const updated = a.updated_at ?? a.created_at ?? a.versions[0]?.created_at
  const dir = a.source_path ? dirOf(a.source_path) : ""
  return (
    <Link
      to="/artifacts/$ref"
      params={{ ref: refFor(a) }}
      data-testid={`profile-work-${a.short_id}`}
      className="group flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 outline-none hover:bg-secondary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      <Badge shape="pill" className="shrink-0">
        {artifactTypeLabel(a)}
      </Badge>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-serif text-base font-medium tracking-tight text-foreground">
          {a.title ?? a.short_id}
        </span>
        {dir && (
          <span
            className="block truncate font-mono text-2xs text-muted-foreground"
            title={a.source_path ?? ""}
          >
            {dir}/
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-3 font-mono text-2xs text-muted-foreground">
        {updated && (
          <time
            dateTime={new Date(updated).toISOString()}
            title={new Date(updated).toLocaleString()}
            className="hidden sm:inline"
          >
            {ago(updated)}
          </time>
        )}
        {a.views !== undefined && a.views > 0 && <Views n={a.views} />}
      </span>
    </Link>
  )
}

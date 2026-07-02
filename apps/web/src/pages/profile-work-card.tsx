import { Link } from "@tanstack/react-router"
import type { Artifact } from "@/api"
import { Icon } from "@/components/icons"
import { Thumb } from "@/components/shared/thumb"
import { TypeTag } from "@/components/shared/type-tag"
import { ago } from "@/lib/time"
import { refFor } from "./artifact/parse-ref"
import { artifactTypeLabel, dirOf } from "./library/artifact-card"

// One piece of a person's work on their profile. A focused, link-first card (no
// favorite/delete chrome — those are library affordances): thumbnail, title, type +
// updated + views. The whole card is the link, so it preloads on hover and opens the
// artifact. Mirrors the library card's look so the two read as one design.
export function ProfileWorkCard({ artifact: a }: { artifact: Artifact }) {
  return (
    <Link
      to="/a/$ref"
      params={{ ref: refFor(a) }}
      data-testid={`profile-work-${a.short_id}`}
      className="group flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-sm)] outline-none transition-shadow duration-150 hover:shadow-[var(--shadow)] focus-visible:border-primary"
    >
      <Thumb id={a.short_id} v={a.current_version} />
      <div className="flex min-w-0 flex-col gap-2 border-t border-border-soft p-3.5">
        <span className="truncate font-display text-lg font-medium tracking-tight text-foreground">
          {a.title ?? a.short_id}
        </span>
        {a.source_path && dirOf(a.source_path) && (
          <span className="truncate font-mono text-2xs text-muted-foreground" title={a.source_path}>
            {dirOf(a.source_path)}/
          </span>
        )}
        <span className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <TypeTag>{artifactTypeLabel(a)}</TypeTag>
          {(a.updated_at ?? a.created_at ?? a.versions[0]?.created_at) && (
            <span>
              updated {ago(a.updated_at ?? a.created_at ?? a.versions[0]?.created_at ?? "")}
            </span>
          )}
          {a.views !== undefined && a.views > 0 && (
            <span className="ml-auto inline-flex items-center gap-1" title={`${a.views} viewers`}>
              <Icon name="views" size={13} />{" "}
              {a.views > 999 ? `${(a.views / 1000).toFixed(1)}k` : a.views}
              <span className="sr-only"> views</span>
            </span>
          )}
        </span>
      </div>
    </Link>
  )
}

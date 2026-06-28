import { API_BASE, type Artifact } from "@/api"

/**
 * Header chrome for a markdown bundle (a skill — entry SKILL.md — or a plain docs
 * folder): a "Skill" badge + declared identity when it's a skill, plus a file tree.
 * The entry doc renders in the iframe below; these chips open the bundle's other
 * files (sibling docs, scripts, references, assets) in a new tab via the raw route.
 * Self-contained — no app state — so it drops in above <ArtifactDocument> without
 * touching the comment/iframe bridge. Renders nothing for a single-file bundle with
 * no skill identity (there'd be nothing to show).
 */
export function BundleBar({
  bundle,
  shortId,
  version,
}: {
  bundle: NonNullable<Artifact["bundle"]>
  shortId: string
  version: number
}) {
  const fileUrl = (path: string) => `${API_BASE}/raw/${shortId}/v/${version}/${path}`
  // The entry doc IS the page below; list only the supporting files.
  const files = bundle.files.filter((f) => f.path !== bundle.entry)
  if (!bundle.isSkill && files.length === 0) return null
  return (
    <div className="border-b border-border bg-secondary/40 px-5 py-3" data-testid="bundle-bar">
      {(bundle.isSkill || bundle.name) && (
        <div className="flex flex-wrap items-center gap-2">
          {bundle.isSkill && (
            <span className="rounded-[5px] border border-primary/40 bg-primary/10 px-1.5 py-px font-mono text-2xs font-semibold uppercase tracking-wide text-primary">
              Skill
            </span>
          )}
          {bundle.name && (
            <span className="font-display text-sm font-semibold text-foreground">
              {bundle.name}
            </span>
          )}
        </div>
      )}
      {bundle.description && (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{bundle.description}</p>
      )}
      {files.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {files.map((f) => (
            <a
              key={f.path}
              href={fileUrl(f.path)}
              target="_blank"
              rel="noopener noreferrer"
              title={f.type}
              className="rounded-md border border-border bg-card px-1.5 py-px font-mono text-2xs text-muted-foreground transition hover:border-primary hover:text-primary"
            >
              {f.path}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

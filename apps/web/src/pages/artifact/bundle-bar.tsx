import { API_BASE, type Artifact } from "@/api"
import { Badge } from "@/components/ui/badge"

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
    // Toolbar canon: matches the view bar in index.tsx (px-4 py-2 border-border).
    <div className="flex flex-col gap-2 border-b border-border px-4 py-2" data-testid="bundle-bar">
      {(bundle.isSkill || bundle.name) && (
        <div className="flex flex-wrap items-center gap-2">
          {bundle.isSkill && (
            // The one brand-chip treatment (Badge brand) — no extra border.
            <Badge variant="brand" shape="pill" className="uppercase tracking-wide">
              Skill
            </Badge>
          )}
          {bundle.name && (
            <span className="font-serif text-base font-medium tracking-tight text-foreground">
              {bundle.name}
            </span>
          )}
        </div>
      )}
      {bundle.description && (
        <p className="line-clamp-2 text-sm text-muted-foreground">{bundle.description}</p>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.map((f) => (
            <Badge key={f.path} asChild variant="outline" shape="pill">
              <a
                href={fileUrl(f.path)}
                target="_blank"
                rel="noopener noreferrer"
                title={f.type}
                className="hover:border-foreground/25 hover:text-foreground"
              >
                {f.path}
              </a>
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}

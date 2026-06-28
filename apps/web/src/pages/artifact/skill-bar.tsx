import { API_BASE, type Artifact } from "@/api"

/**
 * Header chrome for a skill artifact (a bundle whose entry is SKILL.md): its
 * declared identity plus a file tree. The rendered SKILL.md shows in the document
 * iframe below; these chips open the bundle's other files (scripts, references,
 * assets) in a new tab via the raw route. Self-contained — no app state — so it
 * drops in above <ArtifactDocument> without touching the comment/iframe bridge.
 */
export function SkillBar({
  skill,
  shortId,
  version,
}: {
  skill: NonNullable<Artifact["skill"]>
  shortId: string
  version: number
}) {
  const fileUrl = (path: string) => `${API_BASE}/raw/${shortId}/v/${version}/${path}`
  // The entry doc IS the page below; list only the supporting files.
  const files = skill.files.filter((f) => f.path !== skill.entry)
  return (
    <div className="border-b border-border bg-secondary/40 px-5 py-3" data-testid="skill-bar">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-[5px] border border-primary/40 bg-primary/10 px-1.5 py-px font-mono text-2xs font-semibold uppercase tracking-wide text-primary">
          Skill
        </span>
        {skill.name && (
          <span className="font-display text-sm font-semibold text-foreground">{skill.name}</span>
        )}
      </div>
      {skill.description && (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{skill.description}</p>
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

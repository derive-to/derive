import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { API_BASE, type Artifact } from "@/api"
import { Icon } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useCopy } from "@/lib/clipboard"
import { skillGraphQuery, skillUsageQuery } from "@/lib/queries"
import { ago } from "@/lib/time"

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
  if (bundle.isSkill)
    return <SkillWorkbench bundle={bundle} shortId={shortId} version={version} files={files} />
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

function SkillWorkbench({
  bundle,
  shortId,
  version,
  files,
}: {
  bundle: NonNullable<Artifact["bundle"]>
  shortId: string
  version: number
  files: NonNullable<Artifact["bundle"]>["files"]
}) {
  const graph = useQuery(skillGraphQuery(shortId))
  const usage = useQuery(skillUsageQuery(shortId))
  const { copied, copy } = useCopy(2000)
  const nodeById = new Map((graph.data?.nodes ?? []).map((node) => [node.id, node]))
  const activeInstalls = (usage.data?.installations ?? []).reduce(
    (sum, item) => sum + item.count,
    0,
  )
  const contextRuns = (usage.data?.contexts ?? []).reduce((sum, item) => sum + item.count, 0)
  const workflowRuns = (usage.data?.workflows ?? []).reduce((sum, item) => sum + item.count, 0)
  const fileUrl = (path: string) => `${API_BASE}/raw/${shortId}/v/${version}/${path}`
  const installCommand = `derive skill add ${shortId}`
  const workflowLinks = (usage.data?.artifacts ?? []).filter(
    (item, index, all) =>
      item.role === "workflow-definition" &&
      item.artifact &&
      all.findIndex((candidate) => candidate.artifact_id === item.artifact_id) === index,
  )

  return (
    <div className="border-b border-border bg-card/60" data-testid="skill-workbench">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-3">
        <div>
          <div className="flex items-center gap-2">
            <Badge variant="brand" shape="pill" className="uppercase tracking-wide">
              Skill
            </Badge>
            <span className="font-serif text-base font-medium tracking-tight text-foreground">
              {bundle.name ?? shortId}
            </span>
            <span className="font-mono text-2xs text-muted-foreground">v{version}</span>
          </div>
          {bundle.description && (
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{bundle.description}</p>
          )}
        </div>
        <div className="flex min-w-0 flex-col items-end gap-2">
          {workflowLinks.length === 1 && workflowLinks[0]?.artifact ? (
            <Button asChild size="sm" variant="outline" data-testid="skill-open-workflow">
              <Link
                to="/artifacts/$ref"
                params={{ ref: workflowLinks[0].artifact.short_id }}
                title={`Linked from Workflow v${workflowLinks[0].artifact_version}`}
              >
                <Icon name="workflow" size={14} /> Workflow:{" "}
                {workflowLinks[0].artifact.title ?? workflowLinks[0].artifact.short_id}
                <span className="font-mono text-2xs text-muted-foreground">
                  v{workflowLinks[0].artifact_version}
                </span>
              </Link>
            </Button>
          ) : workflowLinks.length > 1 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" data-testid="skill-open-workflows">
                  <Icon name="workflow" size={14} /> {workflowLinks.length} linked workflows
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-w-sm">
                <DropdownMenuLabel>Workflows using this Skill</DropdownMenuLabel>
                {workflowLinks.map((link) =>
                  link.artifact ? (
                    <DropdownMenuItem
                      key={link.artifact_id}
                      asChild
                      data-testid={`skill-workflow-${link.artifact_id}`}
                    >
                      <Link to="/artifacts/$ref" params={{ ref: link.artifact.short_id }}>
                        <Icon name="workflow" size={14} />
                        <span className="min-w-0 flex-1 truncate">
                          {link.artifact.title ?? link.artifact.short_id}
                        </span>
                        <span className="font-mono text-2xs text-muted-foreground">
                          v{link.artifact_version}
                        </span>
                      </Link>
                    </DropdownMenuItem>
                  ) : null,
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <div className="flex gap-1.5">
            <Badge variant="outline" shape="pill">
              Claude
            </Badge>
            <Badge variant="outline" shape="pill">
              Codex
            </Badge>
          </div>
          <div className="flex max-w-full items-center gap-1 rounded-lg border bg-background p-1 pl-2">
            <code className="truncate font-mono text-2xs text-muted-foreground">
              {installCommand}
            </code>
            <Button
              size="xs"
              variant="secondary"
              data-testid="skill-copy-install"
              aria-label={copied ? "Install command copied" : "Copy install command"}
              title="Installs this Skill for Claude and Codex in the current project"
              onClick={() => void copy(installCommand, { success: "Install command copied" })}
            >
              <Icon name={copied ? "check" : "copy"} />
              {copied ? "Copied" : "Install locally"}
            </Button>
          </div>
          <span className="text-2xs text-muted-foreground">Claude + Codex · current project</span>
        </div>
      </div>

      <Tabs defaultValue="overview" className="mt-2">
        <TabsList variant="line" className="px-4" aria-label="Skill views">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="graph">Graph</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
          <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="px-4 py-3">
          <div className="grid gap-2 sm:grid-cols-4">
            <Metric value={graph.data?.edges.length ?? 0} label="connections" />
            <Metric value={activeInstalls} label="active installs" />
            <Metric value={contextRuns} label="Context runs" />
            <Metric value={workflowRuns} label="Workflow runs" />
          </div>
        </TabsContent>
        <TabsContent value="graph" className="px-4 py-3">
          {graph.isPending ? (
            <Muted>Loading connections…</Muted>
          ) : graph.isError ? (
            <Muted>Connections couldn’t be loaded.</Muted>
          ) : graph.data.edges.length ? (
            <div className="flex flex-col gap-2">
              {graph.data.edges.map((edge) => {
                const incoming = edge.target_artifact_id === graph.data.root
                const connected = nodeById.get(
                  incoming ? edge.source_artifact_id : edge.target_artifact_id,
                )
                return (
                  <div
                    key={edge.id}
                    className="flex flex-wrap items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm"
                  >
                    <Badge variant="outline" shape="pill">
                      {incoming ? `used by · ${edge.kind}` : edge.kind}
                    </Badge>
                    {connected ? (
                      <Link
                        to="/artifacts/$ref"
                        params={{ ref: connected.short_id }}
                        className="font-medium hover:underline"
                      >
                        {connected.title ?? connected.short_id}
                      </Link>
                    ) : (
                      <span>Unavailable skill</span>
                    )}
                    <span className="ml-auto font-mono text-2xs text-muted-foreground">
                      v{incoming ? edge.source_version : edge.target_version}
                    </span>
                  </div>
                )
              })}
            </div>
          ) : (
            <Muted>
              This skill stands alone. Add requires, extends, or recommends in derive.skill.json.
            </Muted>
          )}
        </TabsContent>
        <TabsContent value="usage" className="px-4 py-3">
          <div className="grid gap-2 sm:grid-cols-3">
            <Metric value={activeInstalls} label="active installs" />
            <Metric value={contextRuns} label="Context runs" />
            <Metric value={workflowRuns} label="Workflow runs" />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            These are separate observed signals. Derive does not guess local activations or combine
            them into a synthetic total.
          </p>
          {usage.isPending ? (
            <Muted>Loading installation details…</Muted>
          ) : usage.data?.installations.length ? (
            <div className="mt-3 flex flex-col gap-2" data-testid="skill-installations">
              <p className="text-xs font-medium text-foreground">Active installations</p>
              {usage.data.installations.map((installation) => (
                <div
                  key={`${installation.client}:${installation.scope_kind}`}
                  className="flex flex-wrap items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm"
                >
                  <Badge variant="outline" shape="pill" className="capitalize">
                    {installation.client}
                  </Badge>
                  <Badge variant="outline" shape="pill" className="capitalize">
                    {installation.scope_kind}
                  </Badge>
                  <span>
                    {installation.count} {installation.count === 1 ? "install" : "installs"}
                  </span>
                  <span
                    className="ml-auto text-xs text-muted-foreground"
                    title={new Date(installation.last_synced_at).toLocaleString()}
                  >
                    synced {ago(installation.last_synced_at)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">No active installations yet.</p>
          )}
        </TabsContent>
        <TabsContent value="artifacts" className="px-4 py-3">
          {usage.isPending ? (
            <Muted>Loading linked artifacts…</Muted>
          ) : usage.data?.artifacts.length ? (
            <div className="flex flex-wrap gap-2">
              {usage.data.artifacts.map((item) => (
                <Badge key={item.id} asChild={!!item.artifact} variant="outline" shape="pill">
                  {item.artifact ? (
                    <Link to="/artifacts/$ref" params={{ ref: item.artifact.short_id }}>
                      {item.artifact.title ?? item.artifact.short_id} · {item.role} · v
                      {item.artifact_version}
                    </Link>
                  ) : (
                    <span>
                      {item.role} · artifact v{item.artifact_version}
                    </span>
                  )}
                </Badge>
              ))}
            </div>
          ) : (
            <Muted>No artifacts have declared this skill yet.</Muted>
          )}
        </TabsContent>
        <TabsContent value="files" className="px-4 py-3">
          {files.length ? (
            <div className="flex flex-wrap gap-1.5">
              {files.map((file) => (
                <Badge key={file.path} asChild variant="outline" shape="pill">
                  <a href={fileUrl(file.path)} target="_blank" rel="noopener noreferrer">
                    {file.path}
                  </a>
                </Badge>
              ))}
            </div>
          ) : (
            <Muted>This skill contains only SKILL.md.</Muted>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-lg border bg-background px-3 py-2">
      <strong className="font-mono text-base font-medium tabular-nums">{value}</strong>
      <span className="ml-2 text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
      {children}
    </p>
  )
}

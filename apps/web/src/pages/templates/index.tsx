import { useQuery } from "@tanstack/react-query"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { useDeferredValue, useEffect, useState } from "react"
import { api, type TemplateArtifact } from "@/api"
import { Icon } from "@/components/icons"
import { CardGrid } from "@/components/shared/card-grid"
import { EmptyState } from "@/components/shared/empty-state"
import { LoadError } from "@/components/shared/load-error"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { PublicFrame } from "@/components/shared/public-frame"
import { SearchField } from "@/components/shared/search-field"
import { SectionHeading } from "@/components/shared/section-title"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAuth } from "@/ctx"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useDocumentTitle } from "@/lib/use-document-title"
import { refFor } from "@/pages/artifact/parse-ref"
import { AgentTemplateDialog, type AgentTemplateTarget } from "./agent-template-dialog"
import { DeriveSource } from "./derive-source"
import { LibraryShelf } from "./library-shelf"
import { TemplateArtifactCard } from "./template-artifact-card"
import { targetFromArtifact, targetFromLibraryEntry } from "./template-target"
import { TEMPLATE_LIBRARIES_ENABLED, type TemplateTab } from "./types"

const templateMatches = (template: TemplateArtifact, query: string): boolean => {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [template.title ?? "", ...(template.tags ?? [])].join(" ").toLowerCase().includes(needle)
}

/**
 * The template shelf: artifacts tagged `template`, this workspace's then public ones.
 * Starting from one is the artifact page's own "Make a copy", or the agent handoff.
 *
 * Public: signed out, the shelf is the public one, in the anonymous frame, and "Make a
 * copy" goes through sign-in and lands on the template with the copy intent kept.
 */
export function Templates() {
  useDocumentTitle("Templates")
  const { me } = useAuth()
  const signedIn = !!me
  const search = useSearch({ from: "/templates/" })
  const nav = useNavigate({ from: "/templates/" })
  const librariesOpen = signedIn && search.tab === "libraries"
  const query = useDeferredValue(search.query ?? "")
  const shelfState = useQuery({
    queryKey: ["templates", "shelf"],
    queryFn: api.listTemplates,
  })
  const templates = (shelfState.data?.templates ?? []).filter((template) =>
    templateMatches(template, query),
  )
  const workspaceShelf = templates.filter((template) => template.shelf === "workspace")
  const publicShelf = templates.filter((template) => template.shelf === "public")
  const [agentTarget, setAgentTarget] = useState<AgentTemplateTarget | null>(null)
  const [sourceArtifactError, setSourceArtifactError] = useState("")
  // `?source=` (the library's "From an artifact") names an artifact to hand to the agent.
  const sourceArtifact = search.source
  useEffect(() => {
    if (!sourceArtifact) return
    setSourceArtifactError("")
    let active = true
    void api
      .getArtifact(sourceArtifact)
      .then((artifact) => {
        if (!active) return
        setAgentTarget(targetFromArtifact(artifact))
        void nav({ search: (previous) => ({ ...previous, source: undefined }), replace: true })
      })
      .catch(() => {
        if (!active) return
        setSourceArtifactError(
          `Derive couldn’t open “${sourceArtifact}”. Check that it still exists and that you have access, then try another artifact.`,
        )
        void nav({
          search: (previous) => ({ ...previous, source: undefined, derive: true }),
          replace: true,
        })
      })
    return () => {
      active = false
    }
  }, [sourceArtifact, nav])

  const copyMut = useApiMutation({
    mutationFn: (shortId: string) => api.deriveArtifact(shortId),
    pendingKey: (shortId) => shortId,
    invalidate: [["artifacts"], ["summary"]],
    success: "Copied to your workspace",
    onSuccess: (copy) =>
      nav({
        to: "/artifacts/$ref",
        params: { ref: refFor({ short_id: copy.short_id, title: copy.title }) },
      }),
  })

  const setTab = (next: TemplateTab) => {
    setSourceArtifactError("")
    nav({ search: { tab: next, derive: next === "artifacts" ? search.derive : undefined } })
  }

  const shelfFor = (title: string, rows: TemplateArtifact[], testId: string) =>
    rows.length ? (
      <section className="flex flex-col gap-3" data-testid={testId}>
        <SectionHeading count={rows.length}>{title}</SectionHeading>
        <CardGrid>
          {rows.map((template) => (
            <TemplateArtifactCard
              key={template.short_id}
              template={template}
              signedIn={signedIn}
              copying={copyMut.isPendingFor(template.short_id)}
              onCopy={() => copyMut.mutate(template.short_id)}
              onAsk={() => setAgentTarget(targetFromArtifact(template))}
            />
          ))}
        </CardGrid>
      </section>
    ) : null

  const page = (
    <PageShell width="wide" className="flex flex-col gap-6">
      <PageHeader
        title="Templates"
        subtitle="Start from an artifact someone finished. Make a copy, or hand it to your agent."
        actions={
          signedIn ? (
            <>
              <Button
                variant="outline"
                data-testid="templates-create-existing"
                onClick={() => {
                  setSourceArtifactError("")
                  void nav({ search: { ...search, derive: true } })
                }}
              >
                <Icon name="derive" /> Start from an artifact
              </Button>
              <Button data-testid="templates-new-blank" onClick={() => nav({ to: "/new" })}>
                <Icon name="plus" /> Blank artifact
              </Button>
            </>
          ) : undefined
        }
      />

      {signedIn && (TEMPLATE_LIBRARIES_ENABLED || librariesOpen) && (
        <Tabs
          value={librariesOpen ? "libraries" : "artifacts"}
          onValueChange={(value) => setTab(value as TemplateTab)}
        >
          <TabsList variant="line" className="w-full justify-start">
            <TabsTrigger value="artifacts" data-testid="templates-tab-artifacts">
              Templates
            </TabsTrigger>
            <TabsTrigger value="libraries" data-testid="templates-tab-libraries">
              Libraries
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}

      {sourceArtifactError ? (
        <StatusPanel
          tone="warning"
          layout="inline"
          title="Template unavailable"
          description={sourceArtifactError}
        />
      ) : null}

      {signedIn && search.derive && (
        <DeriveSource
          autoFocus={!!search.derive}
          onUse={(artifact) => {
            setSourceArtifactError("")
            setAgentTarget(targetFromArtifact(artifact))
          }}
        />
      )}

      {librariesOpen ? (
        <LibraryShelf
          selectedId={search.library}
          onSelect={(library) => nav({ search: { tab: "libraries", library } })}
          onUse={(entry) => setAgentTarget(targetFromLibraryEntry(entry.library_id, entry))}
        />
      ) : (
        <>
          <SearchField
            value={search.query ?? ""}
            onValueChange={(queryValue) =>
              nav({ search: { ...search, query: queryValue || undefined } })
            }
            placeholder="Search templates"
            aria-label="Search templates"
            testId="templates-search"
            hotkey
          />
          {shelfState.isPending ? (
            <div className="grid min-h-64 place-items-center py-12 text-center" role="status">
              <div className="flex max-w-sm flex-col items-center gap-3 text-muted-foreground">
                <Icon name="derive" size={24} className="animate-pulse" />
                <p className="text-sm">Loading templates…</p>
              </div>
            </div>
          ) : shelfState.isError ? (
            <LoadError
              title="Derive couldn’t load the templates."
              testId="templates-shelf-retry"
              onRetry={() => void shelfState.refetch()}
            />
          ) : templates.length === 0 ? (
            <EmptyState
              icon={<Icon name="templates" />}
              title={query ? "No matching template" : "No templates yet"}
              description={
                query
                  ? "Try a broader word or clear the search."
                  : signedIn
                    ? "Tag any artifact “template” and it appears here for you; show it in the workspace library and teammates see it too. Public ones show up for everyone."
                    : "No public templates yet. Sign in to tag your own."
              }
              action={
                query ? (
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="templates-clear-filters"
                    onClick={() => nav({ search: { tab: "artifacts" } })}
                  >
                    Clear search
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              {shelfFor("This workspace", workspaceShelf, "templates-shelf-workspace")}
              {shelfFor("Public", publicShelf, "templates-shelf-public")}
            </>
          )}
        </>
      )}

      <AgentTemplateDialog
        target={agentTarget}
        onOpenChange={(open) => !open && setAgentTarget(null)}
      />
    </PageShell>
  )

  return signedIn ? page : <PublicFrame returnTo="/templates">{page}</PublicFrame>
}

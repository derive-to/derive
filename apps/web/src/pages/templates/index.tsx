import { useQuery } from "@tanstack/react-query"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { useDeferredValue, useEffect, useState } from "react"
import { api } from "@/api"
import { Icon } from "@/components/icons"
import { CardGrid } from "@/components/shared/card-grid"
import { EmptyState } from "@/components/shared/empty-state"
import { LoadError } from "@/components/shared/load-error"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { SearchField } from "@/components/shared/search-field"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useDocumentTitle } from "@/lib/use-document-title"
import { AgentTemplateDialog, type AgentTemplateTarget } from "./agent-template-dialog"
import { getTemplate, templateMatches } from "./catalog"
import { DeriveSource } from "./derive-source"
import { LibraryShelf } from "./library-shelf"
import { TemplateCard } from "./template-card"
import { targetFromArtifact, targetFromBuiltIn, targetFromLibraryEntry } from "./template-target"
import type { TemplateTab } from "./types"

const TAB_COPY: Record<TemplateTab, string> = {
  artifacts: "Choose a template, describe what you need, and copy the prompt into your agent.",
  contexts: "Start from a reusable agent setup and adapt it to your workspace.",
  libraries: "Use templates your workspace or other teams have shared.",
}

export function Templates() {
  useDocumentTitle("Templates")
  const search = useSearch({ from: "/templates" })
  const nav = useNavigate({ from: "/templates" })
  const tab = search.tab ?? "artifacts"
  const query = useDeferredValue(search.query ?? "")
  const catalogState = useQuery({
    queryKey: ["templates", "built-ins"],
    queryFn: api.listBuiltInTemplates,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const builtIns = catalogState.data?.templates ?? []
  const artifactTemplates = builtIns.filter((template) => template.kind === "artifact")
  const contextTemplates = builtIns.filter((template) => template.kind === "context")
  const artifactCategories = [...new Set(artifactTemplates.map((template) => template.category))]
  const [agentTarget, setAgentTarget] = useState<AgentTemplateTarget | null>(null)
  const [requestedTemplateError, setRequestedTemplateError] = useState("")
  const [sourceArtifactError, setSourceArtifactError] = useState("")
  const sourceArtifact = search.source
  const requestedTemplate = search.use
  useEffect(() => {
    if (!requestedTemplate || catalogState.isPending) return
    const template = getTemplate(builtIns, requestedTemplate)
    void nav({ search: (previous) => ({ ...previous, use: undefined }), replace: true })
    if (!template) {
      setRequestedTemplateError("That built-in template is no longer available.")
      return
    }
    setRequestedTemplateError("")
    setAgentTarget(targetFromBuiltIn(template))
  }, [requestedTemplate, nav, catalogState.isPending, builtIns])
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
  const templates = (tab === "contexts" ? contextTemplates : artifactTemplates).filter(
    (template) =>
      templateMatches(template, query) &&
      (tab !== "artifacts" || !search.category || template.category === search.category),
  )
  const setTab = (next: TemplateTab) => {
    setSourceArtifactError("")
    nav({
      search: {
        tab: next,
        derive: next === "artifacts" ? search.derive : undefined,
        library: undefined,
      },
    })
  }

  const noResults = templates.length === 0
  const copy = TAB_COPY[tab]

  return (
    <PageShell width="wide" className="flex flex-col gap-6">
      <PageHeader
        title="Templates"
        subtitle="Start from a built-in template, a shared library, or work you already trust."
        actions={
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
        }
      />

      <Tabs value={tab} onValueChange={(value) => setTab(value as TemplateTab)}>
        <TabsList variant="line" className="w-full justify-start">
          <TabsTrigger value="artifacts" data-testid="templates-tab-artifacts">
            Artifacts
          </TabsTrigger>
          <TabsTrigger value="contexts" data-testid="templates-tab-contexts">
            Contexts
          </TabsTrigger>
          <TabsTrigger value="libraries" data-testid="templates-tab-libraries">
            Libraries
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <p className="max-w-2xl text-sm text-pretty text-muted-foreground">{copy}</p>

      {requestedTemplateError ? (
        <StatusPanel
          tone="warning"
          layout="inline"
          title="Template unavailable"
          description={requestedTemplateError}
        />
      ) : null}

      {sourceArtifactError ? (
        <StatusPanel
          tone="warning"
          layout="inline"
          title="Source artifact unavailable"
          description={sourceArtifactError}
        />
      ) : null}

      {search.derive && (
        <DeriveSource
          autoFocus={!!search.derive}
          onUse={(artifact) => {
            setSourceArtifactError("")
            setAgentTarget(targetFromArtifact(artifact))
          }}
        />
      )}

      {tab !== "libraries" && (
        <div className="flex flex-col gap-3">
          <SearchField
            value={search.query ?? ""}
            onValueChange={(queryValue) =>
              nav({ search: { ...search, query: queryValue || undefined } })
            }
            placeholder={`Filter ${tab}`}
            aria-label={`Filter ${tab}`}
            testId="templates-search"
            hotkey
          />
          {tab === "artifacts" && (
            <fieldset className="flex flex-wrap gap-1.5">
              <legend className="sr-only">Template categories</legend>
              <Button
                size="xs"
                variant={!search.category ? "default" : "outline"}
                data-testid="templates-category-all"
                onClick={() => nav({ search: { ...search, category: undefined } })}
              >
                All
              </Button>
              {artifactCategories.map((category) => (
                <Button
                  key={category}
                  size="xs"
                  variant={search.category === category ? "default" : "outline"}
                  data-testid={`templates-category-${category.toLowerCase()}`}
                  onClick={() =>
                    nav({
                      search: {
                        ...search,
                        category: search.category === category ? undefined : category,
                      },
                    })
                  }
                >
                  {category}
                </Button>
              ))}
            </fieldset>
          )}
        </div>
      )}

      {tab === "libraries" ? (
        <LibraryShelf
          selectedId={search.library}
          onSelect={(library) => nav({ search: { tab: "libraries", library } })}
          onUse={(entry) => setAgentTarget(targetFromLibraryEntry(entry.library_id, entry))}
        />
      ) : catalogState.isPending ? (
        <div className="grid min-h-64 place-items-center border-y py-12 text-center" role="status">
          <div className="flex max-w-sm flex-col items-center gap-3 text-muted-foreground">
            <Icon name="derive" size={24} className="animate-pulse" />
            <p className="text-sm">Loading built-in templates…</p>
          </div>
        </div>
      ) : catalogState.isError ? (
        <LoadError
          title="Derive couldn’t load the built-in templates."
          description="Your libraries are still available. Retry the catalog when you’re ready."
          testId="templates-catalog-retry"
          onRetry={() => void catalogState.refetch()}
        />
      ) : noResults ? (
        <EmptyState
          icon={<Icon name="templates" />}
          title="No matching shape"
          description="Try a broader word or clear the current category."
          action={
            <Button
              variant="outline"
              size="sm"
              data-testid="templates-clear-filters"
              onClick={() => nav({ search: { tab } })}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <CardGrid>
          {templates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              onUse={() => setAgentTarget(targetFromBuiltIn(template))}
            />
          ))}
        </CardGrid>
      )}

      <section className="grid gap-4 border-t pt-6 sm:grid-cols-[1fr_auto] sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" shape="pill">
              For agents
            </Badge>
            <span className="font-mono text-2xs uppercase tracking-wider text-muted-foreground">
              Same catalog, same releases
            </span>
          </div>
          <h2 className="mt-2 font-serif text-xl font-medium tracking-tight text-foreground">
            Templates are meant to be found, not memorized.
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-pretty text-muted-foreground">
            Built-ins, authored libraries, and pinned starters resolve through the same catalog
            model for the app, CLI, and MCP discovery.
          </p>
        </div>
        <Icon name="derive" size={24} className="text-muted-foreground" />
      </section>
      <AgentTemplateDialog
        target={agentTarget}
        onOpenChange={(open) => !open && setAgentTarget(null)}
      />
    </PageShell>
  )
}

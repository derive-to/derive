import { useQuery } from "@tanstack/react-query"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { useDeferredValue, useEffect, useState } from "react"
import { api } from "@/api"
import { Icon } from "@/components/icons"
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
import { TemplateDetail } from "./template-detail"
import { targetFromArtifact, targetFromBuiltIn, targetFromLibraryEntry } from "./template-target"
import type { TemplateTab } from "./types"

const TAB_COPY: Record<TemplateTab, { title: string; description: string }> = {
  artifacts: {
    title: "Useful shapes for the work that repeats.",
    description: "Choose a strong shape, then tell your agent what to make for you.",
  },
  contexts: {
    title: "Reusable setups for agent work.",
    description: "Brief a proven setup and let your agent adapt it into a working Context.",
  },
  libraries: {
    title: "A useful beginning can travel.",
    description:
      "Build a library from the work you trust, then share its pinned starters with the people—or agents—who need them.",
  },
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
  const selectedTemplate =
    tab !== "libraries"
      ? (getTemplate(builtIns, search.selected) ??
        templates.find((item) => item.featured) ??
        templates[0])
      : undefined

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

  const openTemplate = (template = selectedTemplate) => {
    if (!template) return
    setAgentTarget(targetFromBuiltIn(template))
  }

  const noResults = templates.length === 0
  const copy = TAB_COPY[tab]

  return (
    <PageShell width="wide" className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Built into Derive"
        title="Templates"
        subtitle="Choose a proven starting point, brief your agent, and review a finished first draft."
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
              <Icon name="derive" /> From an artifact
            </Button>
            <Button data-testid="templates-new-blank" onClick={() => nav({ to: "/new" })}>
              <Icon name="plus" /> Blank artifact
            </Button>
          </>
        }
      />

      <section className="grid gap-4 border-y py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="flex flex-col gap-2">
          <h2 className="max-w-2xl font-serif text-3xl font-medium leading-tight tracking-tight text-balance text-foreground">
            {copy.title}
          </h2>
          <p className="max-w-2xl text-sm text-pretty text-muted-foreground">{copy.description}</p>
        </div>
        <div className="flex gap-5 font-mono text-2xs uppercase tracking-wider text-muted-foreground">
          <span>
            <b className="text-foreground">{artifactTemplates.length}</b> artifacts
          </span>
          <span>
            <b className="text-foreground">{contextTemplates.length}</b> contexts
          </span>
        </div>
      </section>

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
              nav({ search: { ...search, query: queryValue || undefined, selected: undefined } })
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
                onClick={() =>
                  nav({ search: { ...search, category: undefined, selected: undefined } })
                }
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
                        selected: undefined,
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
        <StatusPanel
          tone="danger"
          title="Derive couldn’t load the built-in templates."
          description="Your libraries are still available. Retry the catalog when you’re ready."
          action={
            <Button
              variant="outline"
              size="sm"
              data-testid="templates-catalog-retry"
              onClick={() => void catalogState.refetch()}
            >
              Retry
            </Button>
          }
        />
      ) : noResults ? (
        <div className="grid min-h-64 place-items-center border-y py-12 text-center">
          <div className="flex max-w-sm flex-col items-center gap-3">
            <Icon name="templates" size={24} className="text-muted-foreground" />
            <div>
              <h2 className="font-serif text-xl font-medium text-foreground">No matching shape</h2>
              <p className="mt-1 text-sm text-pretty text-muted-foreground">
                Try a broader word or clear the current category.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              data-testid="templates-clear-filters"
              onClick={() => nav({ search: { tab } })}
            >
              Clear filters
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            {templates.map((template, index) => (
              <div
                key={template.id}
                className={index === 0 && !query && !search.category ? "sm:col-span-2" : undefined}
              >
                <TemplateCard
                  template={template}
                  selected={selectedTemplate?.id === template.id}
                  featured={index === 0 && !query && !search.category}
                  onSelect={() => nav({ search: { ...search, selected: template.id } })}
                  onUse={() => openTemplate(template)}
                />
              </div>
            ))}
          </div>

          <div className="min-w-0">
            {selectedTemplate ? (
              <TemplateDetail template={selectedTemplate} onUse={() => openTemplate()} />
            ) : null}
          </div>
        </div>
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

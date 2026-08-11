import { useNavigate, useSearch } from "@tanstack/react-router"
import { useDeferredValue } from "react"
import { Icon } from "@/components/icons"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { SearchField } from "@/components/shared/search-field"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useDocumentTitle } from "@/lib/use-document-title"
import {
  ARTIFACT_TEMPLATES,
  BUILT_IN_THEMES,
  CONTEXT_TEMPLATES,
  getTemplate,
  getTheme,
  TEMPLATE_CATEGORIES,
  templateMatches,
  themeMatches,
} from "./catalog"
import { DeriveSource } from "./derive-source"
import { TemplateCard, ThemeCard } from "./template-card"
import { TemplateDetail, ThemeDetail } from "./template-detail"
import type { TemplateTab } from "./types"

const TAB_COPY: Record<TemplateTab, { title: string; description: string }> = {
  artifacts: {
    title: "Useful shapes for the work that repeats.",
    description: "Start with a strong structure, then make the artifact yours.",
  },
  contexts: {
    title: "Reusable setups for agent work.",
    description: "Publish a safe manifest, then bind the runner, sources, and authority locally.",
  },
  themes: {
    title: "Appearance without rewriting the story.",
    description: "Choose a visual recipe independently from the template's content structure.",
  },
}

export function Templates() {
  useDocumentTitle("Templates")
  const search = useSearch({ from: "/templates" })
  const nav = useNavigate({ from: "/templates" })
  const tab = search.tab ?? "artifacts"
  const query = useDeferredValue(search.query ?? "")
  const selectedTheme = getTheme(search.theme) ?? BUILT_IN_THEMES[0]

  const templates = (tab === "contexts" ? CONTEXT_TEMPLATES : ARTIFACT_TEMPLATES).filter(
    (template) =>
      templateMatches(template, query) &&
      (tab !== "artifacts" || !search.category || template.category === search.category),
  )
  const themes = BUILT_IN_THEMES.filter((theme) => themeMatches(theme, query))
  const selectedTemplate =
    tab !== "themes"
      ? (getTemplate(search.selected) ?? templates.find((item) => item.featured) ?? templates[0])
      : undefined
  const selectedThemeDetail =
    tab === "themes" ? (getTheme(search.selected) ?? themes[0]) : selectedTheme

  const setTab = (next: TemplateTab) =>
    nav({
      search: {
        tab: next,
        theme: next === "artifacts" ? search.theme : undefined,
        derive: search.derive,
      },
    })

  const useTemplate = () => {
    if (!selectedTemplate) return
    const base = { template: selectedTemplate.id }
    if (selectedTemplate.kind === "context") {
      nav({
        to: "/new",
        search: {
          ...base,
          next: "context",
          contextName: selectedTemplate.title,
        },
      })
      return
    }
    nav({
      to: "/new",
      search: {
        ...base,
        theme: selectedTemplate.themeMode === "fixed" ? undefined : selectedTheme?.id,
      },
    })
  }

  const noResults = tab === "themes" ? themes.length === 0 : templates.length === 0
  const copy = TAB_COPY[tab]

  return (
    <PageShell width="wide" className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Built into Derive"
        title="Templates"
        subtitle="A named beginning, never a locked document. Copy one exactly, adapt the draft, or start from any artifact."
        actions={
          <>
            <Button
              variant="outline"
              data-testid="templates-create-existing"
              onClick={() => nav({ search: { ...search, derive: true } })}
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
            <b className="text-foreground">24</b> artifacts
          </span>
          <span>
            <b className="text-foreground">6</b> contexts
          </span>
          <span>
            <b className="text-foreground">5</b> themes
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
          <TabsTrigger value="themes" data-testid="templates-tab-themes">
            Themes
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {(search.derive || tab === "artifacts") && (
        <DeriveSource
          autoFocus={!!search.derive}
          onUse={(source) => nav({ to: "/new", search: { source } })}
        />
      )}

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
            {TEMPLATE_CATEGORIES.map((category) => (
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

      {noResults ? (
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
            {tab === "themes"
              ? themes.map((theme) => (
                  <ThemeCard
                    key={theme.id}
                    theme={theme}
                    selected={selectedThemeDetail?.id === theme.id}
                    onSelect={() => nav({ search: { ...search, selected: theme.id } })}
                  />
                ))
              : templates.map((template, index) => (
                  <div
                    key={template.id}
                    className={
                      index === 0 && !query && !search.category ? "sm:col-span-2" : undefined
                    }
                  >
                    <TemplateCard
                      template={template}
                      selected={selectedTemplate?.id === template.id}
                      featured={index === 0 && !query && !search.category}
                      onSelect={() => nav({ search: { ...search, selected: template.id } })}
                    />
                  </div>
                ))}
          </div>

          <div className="order-first min-w-0 lg:order-last">
            {tab === "themes" && selectedThemeDetail ? (
              <ThemeDetail
                theme={selectedThemeDetail}
                onUse={() =>
                  nav({
                    search: {
                      tab: "artifacts",
                      theme: selectedThemeDetail.id,
                      selected: "narrative-pitch",
                    },
                  })
                }
              />
            ) : selectedTemplate ? (
              <TemplateDetail
                template={selectedTemplate}
                theme={selectedTheme}
                onTheme={(theme) => nav({ search: { ...search, theme } })}
                onUse={useTemplate}
              />
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
            The catalog model is structured for UI, CLI, and MCP discovery. This built-in slice
            keeps those identities stable while the workspace catalog lands.
          </p>
        </div>
        <Icon name="derive" size={24} className="text-muted-foreground" />
      </section>
    </PageShell>
  )
}

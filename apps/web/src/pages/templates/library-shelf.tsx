import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import {
  api,
  type TemplateLibrary,
  type TemplateLibraryEntry,
  type TemplateLibraryScope,
} from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { templateLibrariesQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"

const scopeCopy: Record<
  TemplateLibraryScope,
  { label: string; detail: string; icon: "lock" | "following" | "globe" }
> = {
  private: { label: "Only me", detail: "Visible only to you.", icon: "lock" },
  workspace: { label: "Workspace", detail: "Visible to this workspace.", icon: "following" },
  public: { label: "Public", detail: "Discoverable by anyone and MCP.", icon: "globe" },
}

const csv = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)

function ScopePicker({
  value,
  onChange,
}: {
  value: TemplateLibraryScope
  onChange: (value: TemplateLibraryScope) => void
}) {
  return (
    <fieldset className="grid gap-2 sm:grid-cols-3">
      <legend className="sr-only">Library visibility</legend>
      {(Object.keys(scopeCopy) as TemplateLibraryScope[]).map((scope) => {
        const item = scopeCopy[scope]
        return (
          <button
            key={scope}
            type="button"
            aria-pressed={value === scope}
            onClick={() => onChange(scope)}
            className={`rounded-xl border p-3 text-left outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
              value === scope ? "border-foreground/40 bg-secondary" : "hover:border-foreground/25"
            }`}
          >
            <span className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Icon name={item.icon} size={15} /> {item.label}
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">{item.detail}</span>
          </button>
        )
      })}
    </fieldset>
  )
}

function CreateLibraryDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [scope, setScope] = useState<TemplateLibraryScope>("workspace")
  const create = useApiMutation({
    mutationFn: () =>
      api.createTemplateLibrary({ title: title.trim(), description: description.trim(), scope }),
    invalidate: [["template-libraries"]],
    success: "Template library created",
    onSuccess: () => {
      setTitle("")
      setDescription("")
      setScope("workspace")
      onOpenChange(false)
    },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create a template library</DialogTitle>
          <DialogDescription>
            Libraries are the sharing boundary for reusable starters. You choose who can find them;
            every entry keeps its own pinned source version.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (title.trim()) create.mutate()
          }}
        >
          <label className="grid gap-1.5 text-sm font-medium text-foreground">
            Name
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Product team starters"
              autoFocus
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium text-foreground">
            What belongs here?
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Decision docs, product briefs, and launch-ready pages."
            />
          </label>
          <div className="grid gap-1.5">
            <p className="text-sm font-medium text-foreground">Who can find it?</p>
            <ScopePicker value={scope} onChange={setScope} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!title.trim() || create.isPending}
              data-testid="template-library-create"
            >
              <Icon name="plus" /> Create library
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function LibrarySettingsDialog({
  library,
  open,
  onOpenChange,
}: {
  library: TemplateLibrary
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [title, setTitle] = useState(library.title)
  const [description, setDescription] = useState(library.description)
  const [scope, setScope] = useState<TemplateLibraryScope>(library.scope)
  const update = useApiMutation({
    mutationFn: () =>
      api.updateTemplateLibrary(library.id, {
        title: title.trim(),
        description: description.trim(),
        scope,
      }),
    invalidate: [["template-libraries"], ["template-library", library.id]],
    success: "Library settings saved",
    onSuccess: () => onOpenChange(false),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Library settings</DialogTitle>
          <DialogDescription>
            Change how this reusable collection is named and discovered. Existing starter versions
            remain pinned.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (title.trim()) update.mutate()
          }}
        >
          <label className="grid gap-1.5 text-sm font-medium text-foreground">
            Name
            <Input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
          </label>
          <label className="grid gap-1.5 text-sm font-medium text-foreground">
            Description
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <div className="grid gap-1.5">
            <p className="text-sm font-medium text-foreground">Who can find it?</p>
            <ScopePicker value={scope} onChange={setScope} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim() || update.isPending}>
              Save settings
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function AddEntryDialog({
  libraryId,
  open,
  onOpenChange,
}: {
  libraryId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [source, setSource] = useState("")
  const [kind, setKind] = useState<"artifact" | "context">("artifact")
  const [format, setFormat] = useState<"md" | "html">("md")
  const [category, setCategory] = useState("Doc")
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [outcome, setOutcome] = useState("")
  const [sections, setSections] = useState("")
  const [tags, setTags] = useState("")
  const [themeMode, setThemeMode] = useState<"native" | "adaptable" | "fixed">("fixed")
  const create = useApiMutation({
    mutationFn: () =>
      api.createTemplateLibraryEntry(libraryId, {
        source_short_id: source.trim(),
        kind,
        category:
          category.trim() || (kind === "context" ? "Context" : format === "html" ? "Site" : "Doc"),
        format,
        title: title.trim(),
        description: description.trim(),
        outcome: outcome.trim(),
        sections: csv(sections),
        inputs: [],
        tags: csv(tags),
        theme_mode: themeMode,
      }),
    invalidate: [["template-libraries"], ["template-library", libraryId]],
    success: "Reusable starter published",
    onSuccess: () => {
      setSource("")
      setTitle("")
      setDescription("")
      setOutcome("")
      setSections("")
      setTags("")
      onOpenChange(false)
    },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Make this artifact reusable</DialogTitle>
          <DialogDescription>
            The source stays untouched. Derive captures its current version as an independent,
            version-pinned starter with this metadata.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (source.trim() && title.trim() && description.trim()) create.mutate()
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              Source artifact ID or Derive link
              <Input
                value={source}
                onChange={(event) => setSource(event.target.value)}
                placeholder="decision-memo-ab12cd34@v4"
                autoFocus
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              Display name
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Decision record"
              />
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              Type
              <select
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                value={kind}
                onChange={(event) => setKind(event.target.value as "artifact" | "context")}
              >
                <option value="artifact">Artifact</option>
                <option value="context">Context manifest</option>
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              Format
              <select
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                value={format}
                onChange={(event) => setFormat(event.target.value as "md" | "html")}
              >
                <option value="md">Markdown</option>
                <option value="html">HTML</option>
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              Category
              <Input
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                placeholder="Doc, Deck, Site…"
              />
            </label>
          </div>
          <label className="grid gap-1.5 text-sm font-medium text-foreground">
            Description
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="The repeatable shape and when to use it."
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              Outcome
              <Input
                value={outcome}
                onChange={(event) => setOutcome(event.target.value)}
                placeholder="What a good result makes possible."
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              Theme behavior
              <select
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                value={themeMode}
                onChange={(event) =>
                  setThemeMode(event.target.value as "native" | "adaptable" | "fixed")
                }
              >
                <option value="fixed">Fixed</option>
                <option value="native">Native</option>
                <option value="adaptable">Adaptable</option>
              </select>
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              Sections
              <Input
                value={sections}
                onChange={(event) => setSections(event.target.value)}
                placeholder="Decision, evidence, owner"
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              Tags
              <Input
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                placeholder="decision, leadership"
              />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            Paste an artifact URL or short ID. Contexts remain portable manifests: bind runners,
            sources, permissions, and credentials only after adoption.
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!source.trim() || !title.trim() || !description.trim() || create.isPending}
              data-testid="template-library-entry-create"
            >
              <Icon name="templates" /> Publish starter
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function EntryCard({
  entry,
  canManage,
  onUse,
  onDelete,
}: {
  entry: TemplateLibraryEntry
  canManage: boolean
  onUse: (entry: TemplateLibraryEntry) => void
  onDelete: (entry: TemplateLibraryEntry) => void
}) {
  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" shape="pill">
          {entry.kind === "context" ? "Context" : entry.category}
        </Badge>
        <Badge variant="outline" shape="pill">
          v{entry.source_version}
        </Badge>
        {entry.theme_mode !== "fixed" && (
          <Badge variant="outline" shape="pill">
            Theme-ready
          </Badge>
        )}
      </div>
      <div className="min-w-0">
        <h3 className="font-serif text-xl font-medium tracking-tight text-foreground">
          {entry.title}
        </h3>
        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{entry.description}</p>
      </div>
      {entry.sections.length > 0 && (
        <p className="line-clamp-1 font-mono text-2xs uppercase tracking-wider text-muted-foreground">
          {entry.sections.join(" · ")}
        </p>
      )}
      <div className="mt-auto flex flex-wrap gap-2 border-t pt-3">
        <Button
          size="sm"
          onClick={() => onUse(entry)}
          data-testid={`template-library-use-${entry.id}`}
        >
          <Icon name={entry.kind === "context" ? "context" : "plus"} />{" "}
          {entry.kind === "context" ? "Create manifest" : "Use starter"}
        </Button>
        {canManage && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => onDelete(entry)}
            aria-label={`Delete ${entry.title}`}
          >
            <Icon name="delete" />
          </Button>
        )}
      </div>
    </article>
  )
}

function LibraryDetail({
  libraryId,
  onBack,
  onUse,
}: {
  libraryId: string
  onBack: () => void
  onUse: (entry: TemplateLibraryEntry) => void
}) {
  const detail = useQuery({
    queryKey: ["template-library", libraryId] as const,
    queryFn: () => api.getTemplateLibrary(libraryId),
  })
  const [addOpen, setAddOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const remove = useApiMutation({
    mutationFn: (entry: TemplateLibraryEntry) =>
      api.deleteTemplateLibraryEntry(libraryId, entry.id),
    invalidate: [["template-libraries"], ["template-library", libraryId]],
    success: "Starter removed",
  })
  if (detail.isPending)
    return (
      <div className="grid min-h-64 place-items-center border-y text-sm text-muted-foreground">
        Opening library…
      </div>
    )
  if (detail.isError || !detail.data)
    return (
      <EmptyState
        icon="templates"
        title="This library is unavailable"
        description="It may be private, deleted, or outside your current workspace."
        action={
          <Button variant="outline" onClick={onBack}>
            Back to libraries
          </Button>
        }
      />
    )
  const library = detail.data
  return (
    <section className="flex flex-col gap-5" data-testid="template-library-detail">
      <div className="flex flex-wrap items-start gap-3 border-b pb-5">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <Icon name="chevron-left" /> Libraries
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" shape="pill">
              <Icon name={scopeCopy[library.scope].icon} size={12} />{" "}
              {scopeCopy[library.scope].label}
            </Badge>
            <span className="font-mono text-2xs uppercase tracking-wider text-muted-foreground">
              {library.entry_count} starters · immutable versions
            </span>
          </div>
          <h2 className="mt-3 font-serif text-3xl font-medium tracking-tight text-foreground">
            {library.title}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-pretty text-muted-foreground">
            {library.description || "A reusable collection of Derive starters."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {library.can_manage && (
            <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
              <Icon name="settings" /> Library settings
            </Button>
          )}
          {library.scope === "public" && (
            <Button asChild variant="outline" size="sm">
              <a href={`/template-libraries/${library.id}`} target="_blank" rel="noreferrer">
                <Icon name="globe" /> Public page
              </a>
            </Button>
          )}
          {library.can_manage && (
            <Button onClick={() => setAddOpen(true)}>
              <Icon name="plus" /> Add starter
            </Button>
          )}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {(library.entries ?? []).map((entry) => (
          <EntryCard
            key={entry.id}
            entry={entry}
            canManage={!!library.can_manage}
            onUse={onUse}
            onDelete={(item) => remove.mutate(item)}
          />
        ))}
      </div>
      {(library.entries ?? []).length === 0 && (
        <EmptyState
          icon="templates"
          title="No starters yet"
          description={
            library.can_manage
              ? "Add an artifact to capture a reusable, pinned starting point."
              : "This library is ready for its first published starter."
          }
        />
      )}
      <AddEntryDialog libraryId={libraryId} open={addOpen} onOpenChange={setAddOpen} />
      {settingsOpen && (
        <LibrarySettingsDialog
          key={library.id}
          library={library}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        />
      )}
    </section>
  )
}

export function LibraryShelf({
  selectedId,
  onSelect,
  onUse,
}: {
  selectedId?: string
  onSelect: (id?: string) => void
  onUse: (entry: TemplateLibraryEntry) => void
}) {
  const libraries = useQuery(templateLibrariesQuery())
  const [createOpen, setCreateOpen] = useState(false)
  if (selectedId)
    return <LibraryDetail libraryId={selectedId} onBack={() => onSelect(undefined)} onUse={onUse} />
  return (
    <section className="flex flex-col gap-5" data-testid="template-libraries">
      <div className="flex flex-wrap items-end justify-between gap-4 border-y py-5">
        <div>
          <p className="font-mono text-2xs uppercase tracking-wider text-muted-foreground">
            A shareable starting point
          </p>
          <h2 className="mt-2 font-serif text-3xl font-medium tracking-tight text-foreground">
            Libraries make useful work reusable.
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-pretty text-muted-foreground">
            Publish the version you trust. Others start from an independent copy, with source
            provenance intact.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} data-testid="template-library-new">
          <Icon name="plus" /> New library
        </Button>
      </div>
      {libraries.isPending ? (
        <div className="grid min-h-64 place-items-center border-y text-sm text-muted-foreground">
          Loading libraries…
        </div>
      ) : libraries.isError ? (
        <EmptyState
          icon="templates"
          title="Libraries couldn't load"
          description="Try again in a moment."
          action={
            <Button variant="outline" onClick={() => libraries.refetch()}>
              Retry
            </Button>
          }
        />
      ) : libraries.data?.length ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {libraries.data.map((library) => (
            <button
              key={library.id}
              type="button"
              onClick={() => onSelect(library.id)}
              className="group flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4 text-left outline-none hover:border-foreground/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              data-testid={`template-library-card-${library.id}`}
            >
              <div className="flex items-center justify-between gap-2">
                <Badge variant="outline" shape="pill">
                  <Icon name={scopeCopy[library.scope].icon} size={12} />{" "}
                  {scopeCopy[library.scope].label}
                </Badge>
                <span className="font-mono text-2xs uppercase tracking-wider text-muted-foreground">
                  {library.entry_count} starters
                </span>
              </div>
              <div>
                <h3 className="font-serif text-xl font-medium tracking-tight text-foreground">
                  {library.title}
                </h3>
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                  {library.description || "Reusable Derive starters."}
                </p>
              </div>
              <span className="mt-auto text-sm font-medium text-foreground">
                Browse starters <Icon name="arrow" className="inline size-3.5" />
              </span>
            </button>
          ))}
        </div>
      ) : (
        <EmptyState
          icon="templates"
          title="Create the first shared beginning"
          description="Turn a trusted artifact into a library entry, then share it privately, with your workspace, or publicly."
        />
      )}
      <CreateLibraryDialog open={createOpen} onOpenChange={setCreateOpen} />
    </section>
  )
}

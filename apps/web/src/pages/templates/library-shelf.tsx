import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { useDeferredValue, useState } from "react"
import {
  type Artifact,
  api,
  type TemplateLibrary,
  type TemplateLibraryEntry,
  type TemplateLibraryScope,
} from "@/api"
import { Icon } from "@/components/icons"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { EmptyState } from "@/components/shared/empty-state"
import { SearchField } from "@/components/shared/search-field"
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

const templateLibraryListKeys = [
  ["template-libraries"] as const,
  ["public-template-libraries"] as const,
]
const templateLibraryKeys = (id: string) => [
  ...templateLibraryListKeys,
  ["template-library", id] as const,
  ["public-template-library", id] as const,
]

const csv = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)

// Inputs are optional today, but they are useful context for anyone choosing a
// starter. One line keeps library publishing quick: `*Project name — used in
// the title`; a leading `*` marks the input as required.
const inputsFromLines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const required = line.startsWith("*")
      const [name = "", ...description] = (required ? line.slice(1) : line)
        .split(/\s*(?:—|–|:)\s*/)
        .map((part) => part.trim())
      return {
        name,
        description: description.join(" — ") || "Use this before drafting.",
        required,
      }
    })
    .filter((input) => input.name)

const matches = (query: string, values: Array<string | undefined>) => {
  const needle = query.trim().toLocaleLowerCase()
  return !needle || values.some((value) => value?.toLocaleLowerCase().includes(needle))
}

function ArtifactSourcePicker({
  value,
  onChange,
  onSelect,
}: {
  value: string
  onChange: (value: string) => void
  onSelect: (artifact: Artifact) => void
}) {
  const [query, setQuery] = useState("")
  const deferredQuery = useDeferredValue(query)
  const artifacts = useQuery({
    queryKey: ["template-library-source-picker", deferredQuery] as const,
    queryFn: () => api.listArtifacts({ q: deferredQuery.trim() || undefined, limit: 8 }),
  })
  const items = artifacts.data?.artifacts ?? []
  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium text-foreground">Choose an artifact</legend>
      <p className="text-xs text-muted-foreground">
        Search readable work in this workspace. The current version is captured when you publish the
        starter.
      </p>
      <SearchField
        value={query}
        onValueChange={setQuery}
        loading={artifacts.isFetching}
        placeholder="Search recent artifacts"
        aria-label="Search recent artifacts"
        testId="template-library-source-search"
      />
      {items.length > 0 && (
        <div className="grid max-h-48 gap-1 overflow-y-auto rounded-lg border bg-background p-1.5">
          {items.map((artifact) => {
            const selected = value === artifact.short_id
            return (
              <button
                key={artifact.short_id}
                type="button"
                onClick={() => onSelect(artifact)}
                className={`flex min-w-0 items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                  selected ? "bg-secondary" : "hover:bg-secondary/70"
                }`}
                data-testid={`template-library-source-select-${artifact.short_id}`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {artifact.title || "Untitled artifact"}
                  </span>
                  <span className="font-mono text-2xs text-muted-foreground">
                    {artifact.short_id} · v{artifact.current_version}
                  </span>
                </span>
                <Badge variant="outline" shape="pill">
                  {artifact.current_content_type === "text/x-derive-deck"
                    ? "Deck"
                    : artifact.current_content_type === "text/markdown"
                      ? "Markdown"
                      : "HTML"}
                </Badge>
              </button>
            )
          })}
        </div>
      )}
      {artifacts.isSuccess && items.length === 0 && (
        <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          No readable artifacts match this search. You can still paste a Derive link below.
        </p>
      )}
      <label className="grid gap-1.5 text-sm font-medium text-foreground">
        Or paste a Derive link or short ID
        <Input
          data-testid="template-library-source-paste"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="decision-memo-ab12cd34@v4"
          aria-label="Paste a Derive link or short ID"
        />
      </label>
    </fieldset>
  )
}

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
            data-testid={`template-library-visibility-${scope}`}
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
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (library: TemplateLibrary) => void
}) {
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [scope, setScope] = useState<TemplateLibraryScope>("workspace")
  const create = useApiMutation({
    mutationFn: () =>
      api.createTemplateLibrary({ title: title.trim(), description: description.trim(), scope }),
    invalidate: [...templateLibraryListKeys],
    success: "Template library created",
    onSuccess: (library) => {
      setTitle("")
      setDescription("")
      setScope("workspace")
      onOpenChange(false)
      onCreated(library)
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
              data-testid="template-library-name"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Product team starters"
              autoFocus
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium text-foreground">
            What belongs here?
            <Textarea
              data-testid="template-library-description"
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
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              data-testid="template-library-create-cancel"
            >
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
  onDeleted,
}: {
  library: TemplateLibrary
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted: () => void
}) {
  const [title, setTitle] = useState(library.title)
  const [description, setDescription] = useState(library.description)
  const [scope, setScope] = useState<TemplateLibraryScope>(library.scope)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const update = useApiMutation({
    mutationFn: () =>
      api.updateTemplateLibrary(library.id, {
        title: title.trim(),
        description: description.trim(),
        scope,
      }),
    invalidate: templateLibraryKeys(library.id),
    success: "Library settings saved",
    onSuccess: () => onOpenChange(false),
  })
  const remove = useApiMutation({
    mutationFn: () => api.deleteTemplateLibrary(library.id),
    invalidate: templateLibraryKeys(library.id),
    success: "Template library deleted",
    onSuccess: () => {
      onOpenChange(false)
      onDeleted()
    },
  })
  return (
    <>
      <Dialog open={open && !deleteOpen} onOpenChange={onOpenChange}>
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
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                autoFocus
                data-testid="template-library-settings-name"
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              Description
              <Textarea
                data-testid="template-library-settings-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <div className="grid gap-1.5">
              <p className="text-sm font-medium text-foreground">Who can find it?</p>
              <ScopePicker value={scope} onChange={setScope} />
            </div>
            <DialogFooter className="gap-2 sm:justify-between">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDeleteOpen(true)}
                data-testid="template-library-settings-delete"
              >
                <Icon name="delete" /> Delete library
              </Button>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  data-testid="template-library-settings-cancel"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={!title.trim() || update.isPending}
                  data-testid="template-library-settings-save"
                >
                  Save settings
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${library.title}?`}
        description="This removes the library and its published starters. Source artifacts and adopted work stay untouched."
        confirmLabel="Delete library"
        onConfirm={() => remove.mutateAsync()}
        confirmTestId="template-library-delete-confirm"
      />
    </>
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
  const [step, setStep] = useState<"source" | "details">("source")
  const [source, setSource] = useState("")
  const [selectedSource, setSelectedSource] = useState<Artifact | null>(null)
  const [kind, setKind] = useState<"artifact" | "context">("artifact")
  const [category, setCategory] = useState("Doc")
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [outcome, setOutcome] = useState("")
  const [inputs, setInputs] = useState("")
  const [sections, setSections] = useState("")
  const [tags, setTags] = useState("")
  const create = useApiMutation({
    mutationFn: () =>
      api.createTemplateLibraryEntry(libraryId, {
        source_short_id: source.trim(),
        kind,
        category: category.trim() || (kind === "context" ? "Context" : "Doc"),
        title: title.trim(),
        description: description.trim(),
        outcome: outcome.trim(),
        sections: csv(sections),
        inputs: inputsFromLines(inputs),
        tags: csv(tags),
      }),
    invalidate: templateLibraryKeys(libraryId),
    success: "Reusable starter published",
    onSuccess: () => {
      setStep("source")
      setSource("")
      setSelectedSource(null)
      setKind("artifact")
      setCategory("Doc")
      setTitle("")
      setDescription("")
      setOutcome("")
      setInputs("")
      setSections("")
      setTags("")
      onOpenChange(false)
    },
  })
  const chooseSource = (artifact: Artifact) => {
    setSource(artifact.short_id)
    setSelectedSource(artifact)
    if (!title.trim()) setTitle(artifact.title || "Reusable starter")
    setCategory(
      artifact.current_content_type === "text/x-derive-deck"
        ? "Deck"
        : artifact.current_content_type === "text/markdown"
          ? "Doc"
          : "Site",
    )
  }
  const sourceType = selectedSource
    ? selectedSource.current_content_type === "text/x-derive-deck"
      ? "Derive deck"
      : selectedSource.current_content_type === "text/markdown"
        ? "Markdown"
        : "HTML"
    : "Format detected when published"
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setStep("source")
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <p className="font-mono text-2xs uppercase tracking-wider text-muted-foreground">
            {step === "source" ? "1 of 2 · Choose source" : "2 of 2 · Describe starter"}
          </p>
          <DialogTitle>
            {step === "source" ? "Choose reusable work" : "Name the starter"}
          </DialogTitle>
          <DialogDescription>
            {step === "source"
              ? "Pick any readable artifact. Derive will pin its current version without changing the original."
              : "Add just enough context for someone—or an agent—to know when and how to use it."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (step === "source") {
              if (source.trim()) setStep("details")
            } else if (source.trim() && title.trim() && description.trim()) create.mutate()
          }}
        >
          {step === "source" ? (
            <ArtifactSourcePicker
              value={source}
              onChange={(value) => {
                setSource(value)
                setSelectedSource(null)
              }}
              onSelect={chooseSource}
            />
          ) : (
            <>
              <div className="flex min-w-0 items-center justify-between gap-3 rounded-xl border bg-secondary/40 p-3">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {selectedSource?.title || source}
                  </span>
                  <span className="font-mono text-2xs text-muted-foreground">
                    {sourceType}
                    {selectedSource ? ` · pinned at v${selectedSource.current_version}` : ""}
                  </span>
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setStep("source")}
                  data-testid="template-library-source-change"
                >
                  Change
                </Button>
              </div>
              <label className="grid gap-1.5 text-sm font-medium text-foreground">
                Starter name
                <Input
                  data-testid="template-library-starter-name"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Decision record"
                  autoFocus
                />
              </label>
              <label className="grid gap-1.5 text-sm font-medium text-foreground">
                Description
                <Textarea
                  data-testid="template-library-starter-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="A repeatable shape for documenting a consequential decision."
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1.5 text-sm font-medium text-foreground">
                  Creates a
                  <select
                    data-testid="template-library-starter-kind"
                    className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                    value={kind}
                    onChange={(event) => setKind(event.target.value as "artifact" | "context")}
                  >
                    <option value="artifact">Artifact</option>
                    <option value="context">Context manifest</option>
                  </select>
                </label>
                <label className="grid gap-1.5 text-sm font-medium text-foreground">
                  Category
                  <Input
                    data-testid="template-library-starter-category"
                    value={category}
                    onChange={(event) => setCategory(event.target.value)}
                    placeholder="Doc, Deck, Site…"
                  />
                </label>
              </div>
              <label className="grid gap-1.5 text-sm font-medium text-foreground">
                Starting brief <span className="font-normal text-muted-foreground">(optional)</span>
                <Textarea
                  data-testid="template-library-starter-inputs"
                  value={inputs}
                  onChange={(event) => setInputs(event.target.value)}
                  placeholder={"*Project name — used in the title\nAudience — who this is for"}
                />
                <span className="text-xs font-normal text-muted-foreground">
                  One input per line. Prefix required inputs with *. HTML inputs are limited to
                  visible text so adopting untrusted templates stays safe.
                </span>
              </label>
              <details className="rounded-xl border px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium text-foreground">
                  More discovery details
                </summary>
                <div className="mt-3 grid gap-3">
                  <label className="grid gap-1.5 text-sm font-medium text-foreground">
                    Outcome
                    <Input
                      data-testid="template-library-starter-outcome"
                      value={outcome}
                      onChange={(event) => setOutcome(event.target.value)}
                      placeholder="What a good result makes possible."
                    />
                  </label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="grid gap-1.5 text-sm font-medium text-foreground">
                      Sections
                      <Input
                        data-testid="template-library-starter-sections"
                        value={sections}
                        onChange={(event) => setSections(event.target.value)}
                        placeholder="Decision, evidence, owner"
                      />
                    </label>
                    <label className="grid gap-1.5 text-sm font-medium text-foreground">
                      Tags
                      <Input
                        data-testid="template-library-starter-tags"
                        value={tags}
                        onChange={(event) => setTags(event.target.value)}
                        placeholder="decision, leadership"
                      />
                    </label>
                  </div>
                </div>
              </details>
              <p className="text-xs text-muted-foreground">
                The published starter is a stable snapshot. Context manifests stay portable: connect
                runners, sources, permissions, and credentials only after adoption.
              </p>
            </>
          )}
          <DialogFooter>
            <Button
              data-testid="template-library-entry-back"
              type="button"
              variant="outline"
              onClick={() => (step === "details" ? setStep("source") : onOpenChange(false))}
            >
              {step === "details" ? "Back" : "Cancel"}
            </Button>
            <Button
              type="submit"
              disabled={
                !source.trim() ||
                (step === "details" && (!title.trim() || !description.trim())) ||
                create.isPending
              }
              data-testid="template-library-entry-create"
            >
              {step === "source" ? (
                <>
                  Continue <Icon name="arrow" />
                </>
              ) : (
                <>
                  <Icon name="templates" /> Publish starter
                </>
              )}
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
      </div>
      <div className="min-w-0">
        <h3 className="font-serif text-xl font-medium tracking-tight text-foreground [overflow-wrap:anywhere]">
          {entry.title}
        </h3>
        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{entry.description}</p>
      </div>
      {entry.inputs.length > 0 && (
        <p className="line-clamp-1 text-xs text-muted-foreground">
          Needs:{" "}
          {entry.inputs
            .map((input) => `${input.name}${input.required ? " · required" : ""}`)
            .join(" · ")}
        </p>
      )}
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
          <Icon name="sparkles" /> {entry.kind === "context" ? "Make it ours" : "Make it mine"}
        </Button>
        {canManage && (
          <Button
            data-testid={`template-library-delete-${entry.id}`}
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
  const [query, setQuery] = useState("")
  const remove = useApiMutation({
    mutationFn: (entry: TemplateLibraryEntry) =>
      api.deleteTemplateLibraryEntry(libraryId, entry.id),
    invalidate: templateLibraryKeys(libraryId),
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
          <Button variant="outline" onClick={onBack} data-testid="template-library-error-back">
            Back to libraries
          </Button>
        }
      />
    )
  const library = detail.data
  const allEntries = library.entries ?? []
  const entries = allEntries.filter((entry) =>
    matches(query, [
      entry.title,
      entry.description,
      entry.outcome,
      entry.category,
      entry.kind,
      ...entry.sections,
      ...entry.tags,
      ...entry.inputs.flatMap((input) => [input.name, input.description]),
    ]),
  )
  return (
    <section className="flex flex-col gap-5" data-testid="template-library-detail">
      <div className="flex flex-wrap items-start gap-3 border-b pb-5">
        <Button size="sm" variant="ghost" onClick={onBack} data-testid="template-library-back">
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
          <h2 className="mt-3 font-serif text-3xl font-medium tracking-tight text-foreground [overflow-wrap:anywhere]">
            {library.title}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-pretty text-muted-foreground">
            {library.description || "A reusable collection of Derive starters."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {library.can_manage && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSettingsOpen(true)}
              data-testid="template-library-settings-open"
            >
              <Icon name="settings" /> Library settings
            </Button>
          )}
          {library.scope === "public" && (
            <Button asChild variant="outline" size="sm" data-testid="template-library-public-page">
              <a href={`/template-libraries/${library.id}`} target="_blank" rel="noreferrer">
                <Icon name="globe" /> Public page
              </a>
            </Button>
          )}
          {library.can_manage && (
            <Button onClick={() => setAddOpen(true)} data-testid="template-library-add-starter">
              <Icon name="plus" /> Add starter
            </Button>
          )}
        </div>
      </div>
      {allEntries.length > 1 && (
        <label className="max-w-sm">
          <span className="sr-only">Filter starters</span>
          <Input
            data-testid="template-library-entry-filter"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter starters"
            aria-label="Filter starters"
          />
        </label>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {entries.map((entry) => (
          <EntryCard
            key={entry.id}
            entry={entry}
            canManage={!!library.can_manage}
            onUse={onUse}
            onDelete={(item) => remove.mutate(item)}
          />
        ))}
      </div>
      {allEntries.length === 0 && (
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
      {allEntries.length > 0 && entries.length === 0 && (
        <EmptyState
          icon="templates"
          title="No matching starters"
          description="Try a broader word or clear the current filter."
          action={
            <Button
              variant="outline"
              onClick={() => setQuery("")}
              data-testid="template-library-entry-filter-clear"
            >
              Clear filter
            </Button>
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
          onDeleted={onBack}
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
  const libraries = useInfiniteQuery(templateLibrariesQuery())
  const libraryRows = libraries.data?.pages.flatMap((page) => page.libraries) ?? []
  const [createOpen, setCreateOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [scope, setScope] = useState<"all" | TemplateLibraryScope>("all")
  if (selectedId)
    return <LibraryDetail libraryId={selectedId} onBack={() => onSelect(undefined)} onUse={onUse} />
  const visibleLibraries = libraryRows.filter(
    (library) =>
      (scope === "all" || library.scope === scope) &&
      matches(query, [
        library.title,
        library.description,
        library.scope,
        library.publisher.name ?? undefined,
      ]),
  )
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
        <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:flex-nowrap">
          {libraryRows.length > 1 && (
            <label className="min-w-48 flex-1 sm:w-56 sm:flex-none">
              <span className="sr-only">Search libraries</span>
              <Input
                data-testid="template-library-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search libraries"
                aria-label="Search libraries"
              />
            </label>
          )}
          <Button onClick={() => setCreateOpen(true)} data-testid="template-library-new">
            <Icon name="plus" /> New library
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <fieldset className="flex flex-wrap gap-1.5">
          <legend className="sr-only">Library visibility</legend>
          {(["all", "private", "workspace", "public"] as const).map((value) => (
            <Button
              key={value}
              type="button"
              size="xs"
              variant={scope === value ? "default" : "outline"}
              onClick={() => setScope(value)}
              data-testid={`template-library-scope-${value}`}
            >
              {value === "all" ? "All" : scopeCopy[value].label}
            </Button>
          ))}
        </fieldset>
        <Button asChild variant="ghost" size="sm" data-testid="template-library-explore-public">
          <a href="/template-libraries">
            <Icon name="globe" /> Explore public libraries
          </a>
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
            <Button
              variant="outline"
              onClick={() => libraries.refetch()}
              data-testid="template-library-retry"
            >
              Retry
            </Button>
          }
        />
      ) : libraryRows.length && visibleLibraries.length ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {visibleLibraries.map((library) => (
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
                  <h3 className="font-serif text-xl font-medium tracking-tight text-foreground [overflow-wrap:anywhere]">
                    {library.title}
                  </h3>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                    {library.description || "Reusable Derive starters."}
                  </p>
                </div>
                {(library.publisher.name || library.publisher.username) && (
                  <span className="text-xs text-muted-foreground">
                    Published by {library.publisher.name ?? `@${library.publisher.username}`}
                  </span>
                )}
                <span className="mt-auto text-sm font-medium text-foreground">
                  Browse starters <Icon name="arrow" className="inline size-3.5" />
                </span>
              </button>
            ))}
          </div>
          {libraries.hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                onClick={() => libraries.fetchNextPage()}
                disabled={libraries.isFetchingNextPage}
                data-testid="template-libraries-load-more"
              >
                {libraries.isFetchingNextPage ? "Loading…" : "Load more libraries"}
              </Button>
            </div>
          )}
        </>
      ) : libraryRows.length ? (
        <EmptyState
          icon="templates"
          title="No matching libraries"
          description="Try a broader word or clear the current search."
          action={
            <Button
              variant="outline"
              onClick={() => setQuery("")}
              data-testid="template-library-search-clear"
            >
              Clear search
            </Button>
          }
        />
      ) : (
        <EmptyState
          icon="templates"
          title="Create the first shared beginning"
          description="Turn a trusted artifact into a library entry, then share it privately, with your workspace, or publicly."
        />
      )}
      <CreateLibraryDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(library) => onSelect(library.id)}
      />
    </section>
  )
}

import { useReducer } from "react"
import { type Artifact, api } from "@/api"
import { Icon } from "@/components/icons"
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
import { useApiMutation } from "@/lib/use-api-mutation"
import { initialAddEntryState, reduceAddEntry } from "./add-entry-state"
import { ArtifactSourcePicker } from "./artifact-source-picker"
import { csv, inputsFromLines, templateLibraryKeys } from "./template-library-helpers"

export function AddEntryDialog({
  libraryId,
  open,
  onOpenChange,
}: {
  libraryId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [form, dispatch] = useReducer(reduceAddEntry, undefined, initialAddEntryState)
  const {
    step,
    source,
    selectedSource,
    kind,
    category,
    title,
    description,
    outcome,
    inputs,
    sections,
    tags,
  } = form
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
      dispatch({ type: "reset" })
      onOpenChange(false)
    },
  })
  const chooseSource = (artifact: Artifact) => {
    dispatch({ type: "select-source", artifact })
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
        if (!nextOpen) dispatch({ type: "reset" })
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
              if (source.trim()) dispatch({ type: "set-step", step: "details" })
            } else if (source.trim() && title.trim() && description.trim()) create.mutate()
          }}
        >
          {step === "source" ? (
            <ArtifactSourcePicker
              value={source}
              onChange={(value) => dispatch({ type: "paste-source", source: value })}
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
                  onClick={() => dispatch({ type: "set-step", step: "source" })}
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
                  onChange={(event) =>
                    dispatch({ type: "set-field", field: "title", value: event.target.value })
                  }
                  placeholder="Decision record"
                  autoFocus
                />
              </label>
              <label className="grid gap-1.5 text-sm font-medium text-foreground">
                Description
                <Textarea
                  data-testid="template-library-starter-description"
                  value={description}
                  onChange={(event) =>
                    dispatch({
                      type: "set-field",
                      field: "description",
                      value: event.target.value,
                    })
                  }
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
                    onChange={(event) =>
                      dispatch({
                        type: "set-kind",
                        kind: event.target.value as "artifact" | "context",
                      })
                    }
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
                    onChange={(event) =>
                      dispatch({ type: "set-field", field: "category", value: event.target.value })
                    }
                    placeholder="Doc, Deck, Site…"
                  />
                </label>
              </div>
              <label className="grid gap-1.5 text-sm font-medium text-foreground">
                Starting brief <span className="font-normal text-muted-foreground">(optional)</span>
                <Textarea
                  data-testid="template-library-starter-inputs"
                  value={inputs}
                  onChange={(event) =>
                    dispatch({ type: "set-field", field: "inputs", value: event.target.value })
                  }
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
                      onChange={(event) =>
                        dispatch({ type: "set-field", field: "outcome", value: event.target.value })
                      }
                      placeholder="What a good result makes possible."
                    />
                  </label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="grid gap-1.5 text-sm font-medium text-foreground">
                      Sections
                      <Input
                        data-testid="template-library-starter-sections"
                        value={sections}
                        onChange={(event) =>
                          dispatch({
                            type: "set-field",
                            field: "sections",
                            value: event.target.value,
                          })
                        }
                        placeholder="Decision, evidence, owner"
                      />
                    </label>
                    <label className="grid gap-1.5 text-sm font-medium text-foreground">
                      Tags
                      <Input
                        data-testid="template-library-starter-tags"
                        value={tags}
                        onChange={(event) =>
                          dispatch({ type: "set-field", field: "tags", value: event.target.value })
                        }
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
              onClick={() =>
                step === "details"
                  ? dispatch({ type: "set-step", step: "source" })
                  : onOpenChange(false)
              }
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

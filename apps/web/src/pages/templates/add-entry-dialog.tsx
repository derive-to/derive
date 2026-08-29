import { useReducer } from "react"
import { type Artifact, api } from "@/api"
import { Icon } from "@/components/icons"
import { FormField } from "@/components/shared/form-field"
import { Eyebrow } from "@/components/shared/section-eyebrow"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useApiMutation } from "@/lib/use-api-mutation"
import { initialAddEntryState, reduceAddEntry } from "./add-entry-state"
import { ArtifactSourcePicker } from "./artifact-source-picker"
import { artifactTemplateFormat } from "./artifact-template-format"
import { templateLibraryInvalidation } from "./template-library-queries"

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
  const { step, source, selectedSource, kind, category, title, description } = form
  const create = useApiMutation({
    mutationFn: () =>
      api.createTemplateLibraryEntry(libraryId, {
        source_short_id: source.trim(),
        kind,
        category: kind === "context" ? "Context" : category.trim() || "Doc",
        title: title.trim(),
        description: description.trim(),
        outcome: "",
        sections: [],
        inputs: [],
        tags: [],
      }),
    invalidate: templateLibraryInvalidation,
    success: "Reusable starter published",
    onSuccess: () => {
      dispatch({ type: "reset" })
      onOpenChange(false)
    },
  })
  const closeAndReset = () => {
    if (create.isPending) return
    dispatch({ type: "reset" })
    onOpenChange(false)
  }
  const chooseSource = (artifact: Artifact) => {
    dispatch({ type: "select-source", artifact })
  }
  const sourceType = selectedSource
    ? (artifactTemplateFormat(selectedSource.current_content_type)?.label ?? "Unsupported format")
    : "Format detected when published"
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) onOpenChange(true)
        else closeAndReset()
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <Eyebrow as="div">
            {step === "source" ? "1 of 2 · Choose source" : "2 of 2 · Describe starter"}
          </Eyebrow>
          <DialogTitle>
            {step === "source" ? "Choose reusable work" : "Name the starter"}
          </DialogTitle>
          <DialogDescription>
            {step === "source"
              ? "Pick any readable artifact. Derive will pin its current version without changing the original."
              : "Add enough context for a person or agent to know when and how to use it."}
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
              <FormField label="Starter name" htmlFor="template-library-starter-name-field">
                <Input
                  id="template-library-starter-name-field"
                  data-testid="template-library-starter-name"
                  value={title}
                  onChange={(event) =>
                    dispatch({ type: "set-field", field: "title", value: event.target.value })
                  }
                  placeholder="Decision record"
                  autoFocus
                />
              </FormField>
              <FormField label="Description" htmlFor="template-library-starter-description-field">
                <Textarea
                  id="template-library-starter-description-field"
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
              </FormField>
              <FormField label="Creates a" htmlFor="template-library-starter-kind-field">
                <Select
                  value={kind}
                  onValueChange={(value) =>
                    dispatch({ type: "set-kind", kind: value as "artifact" | "context" })
                  }
                >
                  <SelectTrigger
                    id="template-library-starter-kind-field"
                    data-testid="template-library-starter-kind"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="artifact">Artifact</SelectItem>
                    <SelectItem value="context">Context</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
              <p className="text-xs text-muted-foreground">
                The published starter is a stable snapshot. The agent reads the pinned source when
                someone uses it, so there is no separate template schema to maintain.
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
                  : closeAndReset()
              }
              disabled={create.isPending}
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

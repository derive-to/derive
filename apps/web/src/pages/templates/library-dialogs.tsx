import { useState } from "react"
import { api, type TemplateLibrary, type TemplateLibraryScope } from "@/api"
import { Icon } from "@/components/icons"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
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
import { scopeCopy, templateLibraryKeys, templateLibraryListKeys } from "./template-library-helpers"

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

function LibraryFormFields({
  title,
  onTitleChange,
  description,
  onDescriptionChange,
  scope,
  onScopeChange,
  mode,
}: {
  title: string
  onTitleChange: (value: string) => void
  description: string
  onDescriptionChange: (value: string) => void
  scope: TemplateLibraryScope
  onScopeChange: (value: TemplateLibraryScope) => void
  mode: "create" | "settings"
}) {
  const testIdPrefix = mode === "create" ? "template-library" : "template-library-settings"
  return (
    <>
      <label className="grid gap-1.5 text-sm font-medium text-foreground">
        Name
        <Input
          data-testid={`${testIdPrefix}-name`}
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
          placeholder={mode === "create" ? "Product team starters" : undefined}
          autoFocus
        />
      </label>
      <label className="grid gap-1.5 text-sm font-medium text-foreground">
        {mode === "create" ? "What belongs here?" : "Description"}
        <Textarea
          data-testid={`${testIdPrefix}-description`}
          value={description}
          onChange={(event) => onDescriptionChange(event.target.value)}
          placeholder={
            mode === "create" ? "Decision docs, product briefs, and launch-ready pages." : undefined
          }
        />
      </label>
      <div className="grid gap-1.5">
        <p className="text-sm font-medium text-foreground">Who can find it?</p>
        <ScopePicker value={scope} onChange={onScopeChange} />
      </div>
    </>
  )
}

export function CreateLibraryDialog({
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
          <LibraryFormFields
            title={title}
            onTitleChange={setTitle}
            description={description}
            onDescriptionChange={setDescription}
            scope={scope}
            onScopeChange={setScope}
            mode="create"
          />
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

export function LibrarySettingsDialog({
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
            <LibraryFormFields
              title={title}
              onTitleChange={setTitle}
              description={description}
              onDescriptionChange={setDescription}
              scope={scope}
              onScopeChange={setScope}
              mode="settings"
            />
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

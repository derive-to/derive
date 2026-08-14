import { useState } from "react"
import { api, type TemplateLibrary, type TemplateLibraryScope } from "@/api"
import { Icon } from "@/components/icons"
import { AccessSegmentToggle } from "@/components/shared/access-segment-toggle"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { FormField } from "@/components/shared/form-field"
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
import { scopeCopy } from "./template-library-helpers"
import { templateLibraryInvalidation } from "./template-library-queries"

const SCOPE_SEGMENTS = (Object.keys(scopeCopy) as TemplateLibraryScope[]).map((scope) => ({
  value: scope,
  label: scopeCopy[scope].label,
  icon: scopeCopy[scope].icon,
}))

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
  const nameId = `${testIdPrefix}-name-field`
  const descriptionId = `${testIdPrefix}-description-field`
  return (
    <>
      <FormField label="Name" htmlFor={nameId}>
        <Input
          id={nameId}
          data-testid={`${testIdPrefix}-name`}
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
          placeholder={mode === "create" ? "Product team starters" : undefined}
          autoFocus
        />
      </FormField>
      <FormField
        label={mode === "create" ? "What belongs here?" : "Description"}
        htmlFor={descriptionId}
      >
        <Textarea
          id={descriptionId}
          data-testid={`${testIdPrefix}-description`}
          value={description}
          onChange={(event) => onDescriptionChange(event.target.value)}
          placeholder={
            mode === "create" ? "Decision docs, product briefs, and launch-ready pages." : undefined
          }
        />
      </FormField>
      <FormField label="Who can find it?" hint={scopeCopy[scope].detail}>
        <AccessSegmentToggle
          segments={SCOPE_SEGMENTS}
          value={scope}
          onChange={onScopeChange}
          testId="template-library-visibility"
        />
      </FormField>
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
  const resetForm = () => {
    setTitle("")
    setDescription("")
    setScope("workspace")
  }
  const create = useApiMutation({
    mutationFn: () =>
      api.createTemplateLibrary({ title: title.trim(), description: description.trim(), scope }),
    invalidate: templateLibraryInvalidation,
    success: "Template library created",
    onSuccess: (library) => {
      resetForm()
      onOpenChange(false)
      onCreated(library)
    },
  })
  const closeAndReset = () => {
    if (create.isPending) return
    resetForm()
    onOpenChange(false)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) onOpenChange(true)
        else closeAndReset()
      }}
    >
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
              onClick={closeAndReset}
              disabled={create.isPending}
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
    invalidate: templateLibraryInvalidation,
    success: "Library settings saved",
    onSuccess: () => onOpenChange(false),
  })
  const remove = useApiMutation({
    mutationFn: () => api.deleteTemplateLibrary(library.id),
    invalidate: templateLibraryInvalidation,
    success: "Template library deleted",
    onSuccess: () => {
      onOpenChange(false)
      onDeleted()
    },
  })
  const busy = update.isPending || remove.isPending
  return (
    <>
      <Dialog
        open={open && !deleteOpen}
        onOpenChange={(nextOpen) => {
          if (!busy) onOpenChange(nextOpen)
        }}
      >
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
                disabled={busy}
                data-testid="template-library-settings-delete"
              >
                <Icon name="delete" /> Delete library
              </Button>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={busy}
                  data-testid="template-library-settings-cancel"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={!title.trim() || busy}
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
        onOpenChange={(nextOpen) => {
          if (!remove.isPending) setDeleteOpen(nextOpen)
        }}
        title={`Delete ${library.title}?`}
        description="This removes the library and its published starters. Source artifacts and adopted work stay untouched."
        confirmLabel="Delete library"
        onConfirm={() => remove.mutateAsync()}
        confirmTestId="template-library-delete-confirm"
      />
    </>
  )
}

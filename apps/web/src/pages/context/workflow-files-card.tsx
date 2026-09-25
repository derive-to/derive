import { useRef, useState } from "react"
import { type Artifact, api } from "@/api"
import { SectionTitle } from "@/components/shared/section-title"
import { Button } from "@/components/ui/button"
import { workflowConfigurationQuery, workflowRuntimesQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import {
  type PreparedWorkflowFiles,
  prepareWorkflowFiles,
  workflowFilesZip,
} from "@/lib/workflow-files"

type Selection = { prepared: PreparedWorkflowFiles; revision: number | null; uploaded?: Artifact }
type Configuration = Awaited<ReturnType<typeof api.workflowConfiguration>>
const size = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`

export function WorkflowFilesCard({
  contextId,
  configuration,
}: {
  contextId: string
  configuration: Configuration
}) {
  const folder = useRef<HTMLInputElement>(null)
  const archive = useRef<HTMLInputElement>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [reading, setReading] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const current = configuration.files
  const attached = !!current?.artifact_id
  const invalidate = [
    workflowConfigurationQuery(contextId).queryKey,
    workflowRuntimesQuery().queryKey,
  ]
  const save = useApiMutation({
    mutationFn: async (selected: Selection) => {
      const uploaded =
        selected.uploaded ??
        (await api.publish(await workflowFilesZip(selected.prepared), {
          title: selected.prepared.name,
          file_bundle: "true",
          workspace_access: "none",
          link_role: "none",
          listed: "none",
        }))
      // If assignment fails, retain the uploaded artifact and retry only the assignment.
      setSelection({ ...selected, uploaded })
      await api.saveWorkflowFiles(contextId, {
        short_id: uploaded.short_id,
        version: uploaded.current_version,
        revision: selected.revision,
      })
    },
    invalidate,
    success: "Input files attached",
    onSuccess: () => setSelection(null),
    errorToast: false,
  })
  const remove = useApiMutation({
    mutationFn: () =>
      api.saveWorkflowFiles(contextId, {
        short_id: null,
        version: null,
        revision: current?.revision ?? null,
      }),
    invalidate,
    success: "Input attachment removed. Saved working files are unchanged.",
  })
  const choose = async (files: File[]) => {
    setReading(true)
    setReadError(null)
    setSelection(null)
    save.reset()
    const revision = current?.revision ?? null
    try {
      setSelection({ prepared: await prepareWorkflowFiles(files), revision })
    } catch (error) {
      setReadError(error instanceof Error ? error.message : "Could not read those files")
    } finally {
      setReading(false)
    }
  }
  const pending = reading || save.isPending || remove.isPending
  const stale = !!selection && selection.revision !== (current?.revision ?? null)
  return (
    <section
      className="flex flex-col gap-4 rounded-xl border bg-card p-5"
      aria-label="Workflow input files"
      id="workflow-files"
    >
      <div className="flex flex-col gap-1">
        <SectionTitle>Input files</SectionTitle>
        <p className="text-sm text-muted-foreground">
          Scripts and data for your workflow. The agent handles dependencies.
        </p>
      </div>
      {attached ? (
        <div className="flex items-start justify-between gap-3 rounded-lg border bg-muted/30 p-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{current.title ?? "Input files"}</p>
            <p className="text-sm text-muted-foreground">
              Version {current.version} · pinned for this workflow
            </p>
          </div>
          {configuration.readiness.can_edit && (
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              data-testid="workflow-files-remove"
              onClick={() => remove.mutate()}
            >
              Remove
            </Button>
          )}
        </div>
      ) : (
        !selection && (
          <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
            Add a folder from your computer, or start with instructions alone.
          </p>
        )
      )}
      {configuration.readiness.can_edit && (
        <>
          <input
            ref={folder}
            type="file"
            multiple
            {...{ webkitdirectory: "" }}
            className="sr-only"
            aria-label="Choose input folder"
            data-testid="workflow-files-folder"
            disabled={pending}
            onChange={(event) => {
              void choose(Array.from(event.target.files ?? []))
              event.target.value = ""
            }}
          />
          <input
            ref={archive}
            type="file"
            accept=".zip,application/zip"
            className="sr-only"
            aria-label="Choose input ZIP"
            data-testid="workflow-files-zip"
            disabled={pending}
            onChange={(event) => {
              void choose(Array.from(event.target.files ?? []))
              event.target.value = ""
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              data-testid="workflow-files-choose-folder"
              onClick={() => folder.current?.click()}
            >
              {reading ? "Reading files…" : "Choose folder"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              data-testid="workflow-files-choose-zip"
              onClick={() => archive.current?.click()}
            >
              Choose ZIP
            </Button>
            <span className="text-sm text-muted-foreground">Up to 2,000 files · 50 MB</span>
          </div>
        </>
      )}
      {selection && (
        <div className="flex flex-col gap-3 rounded-lg border p-4">
          <div>
            <p className="text-sm font-medium">{selection.prepared.name}</p>
            <p className="text-sm text-muted-foreground">
              {selection.prepared.paths.length}{" "}
              {selection.prepared.paths.length === 1 ? "file" : "files"} ·{" "}
              {size(selection.prepared.bytes)}
            </p>
          </div>
          <ul
            className="max-h-40 overflow-auto font-mono text-xs text-muted-foreground"
            aria-label="Files to attach"
          >
            {selection.prepared.paths.map((path) => (
              <li key={path} className="truncate py-1" title={path}>
                {path}
              </li>
            ))}
          </ul>
          {!!selection.prepared.excluded.length && (
            <details className="text-sm text-muted-foreground">
              <summary>
                Excluded {selection.prepared.excluded.length}{" "}
                {selection.prepared.excluded.length === 1
                  ? "credential or cache entry"
                  : "credential or cache entries"}
              </summary>
              <ul>
                {selection.prepared.excluded.map((path) => (
                  <li key={path} className="break-all">
                    {path}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="text-sm text-muted-foreground">
            People allowed to run this workflow can use these files. The source stays private. Your
            agent’s saved working files stay intact.
          </p>
          {stale && (
            <p role="alert" className="text-sm text-destructive">
              The attachment changed while you were reviewing. Check it above before replacing it.
            </p>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={pending}
              data-testid="workflow-files-attach"
              onClick={() => save.mutate({ ...selection, revision: current?.revision ?? null })}
            >
              {save.isPending
                ? "Attaching…"
                : stale
                  ? "Replace attachment"
                  : selection.uploaded
                    ? "Retry attachment"
                    : "Attach files"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              data-testid="workflow-files-cancel"
              onClick={() => {
                setSelection(null)
                save.reset()
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {(readError || save.error) && (
        <p role="alert" className="text-sm text-destructive">
          {readError ?? save.error?.message}
        </p>
      )}
      {attached && (
        <p className="text-sm text-muted-foreground">
          New attachments apply to future runs. Working files are kept between runs.
        </p>
      )}
    </section>
  )
}

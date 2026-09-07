import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { ApiError, api } from "@/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { previewArxivRef } from "@/lib/arxiv-ref"
import { useApiMutation } from "@/lib/use-api-mutation"
import { BUILDER_COPY } from "./builder-copy"
import { importErrorCopy } from "./import-copy"

// The paper door: an arXiv link in, a read-only Context out. The form previews what the
// server will parse as the person types (the same grammar, client-side), submits, and
// lands on the new Context's console, which shows the paper arriving. The Context exists
// from the first response, so a second paste of the same paper opens the same page.
export function ArxivImportForm({ initialUrl = "" }: { initialUrl?: string }) {
  const [url, setUrl] = useState(initialUrl)
  const nav = useNavigate()
  const ref = previewArxivRef(url)
  const create = useApiMutation({
    mutationFn: () => api.importArxivContext(url.trim()),
    success: BUILDER_COPY.arxivQueued,
    // The refusal reads under the field, in the form's own words for its code.
    errorToast: false,
    onSuccess: (ctx) => {
      setUrl("")
      nav({ to: "/contexts/$id", params: { id: ctx.id } })
    },
  })
  const error = create.error
  const errorText = error
    ? importErrorCopy(error instanceof ApiError ? (error.code ?? null) : null, error.message)
    : null
  const submit = () => {
    if (ref && !create.isPending) create.mutate()
  }

  return (
    <div
      className="flex flex-col gap-3 rounded-xl border bg-card p-3"
      data-testid="context-arxiv-form"
    >
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">{BUILDER_COPY.arxivTitle}</p>
        <p className="text-sm text-muted-foreground">{BUILDER_COPY.arxivBody}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          data-testid="context-arxiv-link"
          aria-label="arXiv link or id"
          placeholder={BUILDER_COPY.arxivPlaceholder}
          value={url}
          onChange={(e) => {
            setUrl(e.target.value)
            if (create.error) create.reset()
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit()
          }}
          className="min-w-64 flex-1 font-mono"
        />
        <Button
          data-testid="context-arxiv-submit"
          onClick={submit}
          disabled={!ref || create.isPending}
        >
          {BUILDER_COPY.arxivFetch}
        </Button>
      </div>
      {errorText ? (
        <p role="alert" data-testid="context-arxiv-error" className="text-sm text-destructive">
          {errorText}
        </p>
      ) : (
        <p
          role="status"
          data-testid="context-arxiv-preview"
          className="font-mono text-2xs text-muted-foreground"
        >
          {url.trim() ? (ref ? `arXiv:${ref.canonical}` : BUILDER_COPY.arxivInvalid) : " "}
        </p>
      )}
    </div>
  )
}

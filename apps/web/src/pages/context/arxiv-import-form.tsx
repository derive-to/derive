import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { ApiError, api } from "@/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { previewArxivRef } from "@/lib/arxiv-ref"
import { previewRepoRef } from "@/lib/repo-ref"
import { useApiMutation } from "@/lib/use-api-mutation"
import { BUILDER_COPY } from "./builder-copy"
import { importErrorCopy } from "./import-copy"

// The paper door: an arXiv link in, a read-only Context out. The form previews what the
// server will parse as the person types (the same grammar, client-side), submits, and
// lands on the new Context's console, which shows the paper arriving. The Context exists
// from the first response, so a second paste of the same paper opens the same page.
export function ArxivImportForm({ initialUrl = "" }: { initialUrl?: string }) {
  const [url, setUrl] = useState(initialUrl)
  // The paper's implementation, optional. Empty is fine; anything that is not a
  // repository blocks the submit the same way a bad arXiv link does, so the refusal
  // happens here rather than a minute into the fetch.
  const [codeUrl, setCodeUrl] = useState("")
  const nav = useNavigate()
  const ref = previewArxivRef(url)
  const codeRef = previewRepoRef(codeUrl)
  const codeReady = codeUrl.trim() === "" || codeRef !== null
  const create = useApiMutation({
    mutationFn: () => api.importArxivContext(url.trim(), codeRef?.webUrl),
    success: BUILDER_COPY.arxivQueued,
    // The refusal reads under the field, in the form's own words for its code.
    errorToast: false,
    onSuccess: (ctx) => {
      setUrl("")
      setCodeUrl("")
      nav({ to: "/contexts/$id", params: { id: ctx.id } })
    },
  })
  const error = create.error
  const errorText = error
    ? importErrorCopy(error instanceof ApiError ? (error.code ?? null) : null, error.message)
    : null
  const submit = () => {
    if (ref && codeReady && !create.isPending) create.mutate()
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
          disabled={!ref || !codeReady || create.isPending}
        >
          {BUILDER_COPY.arxivFetch}
        </Button>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="context-arxiv-code" className="text-sm font-medium text-foreground">
          {BUILDER_COPY.codeLabel}
        </label>
        <p className="text-sm text-muted-foreground">{BUILDER_COPY.codeBody}</p>
        <Input
          id="context-arxiv-code"
          data-testid="context-arxiv-code"
          placeholder={BUILDER_COPY.codePlaceholder}
          value={codeUrl}
          onChange={(e) => {
            setCodeUrl(e.target.value)
            if (create.error) create.reset()
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit()
          }}
          className="mt-1 font-mono"
        />
        <p
          role="status"
          data-testid="context-arxiv-code-preview"
          className="font-mono text-2xs text-muted-foreground"
        >
          {codeUrl.trim() ? (codeRef ? codeRef.canonical : BUILDER_COPY.codeInvalid) : " "}
        </p>
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

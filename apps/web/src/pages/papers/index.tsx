import { useQuery, useQueryClient } from "@tanstack/react-query"
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { Copy as CopyIcon, TriangleAlert } from "lucide-react"
import { useState } from "react"
import { ApiError, api, type ContextDetail } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { SectionTitle } from "@/components/shared/section-title"
import { Spinner } from "@/components/shared/spinner"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { useAuth } from "@/ctx"
import { copyText } from "@/lib/clipboard"
import { paperQuery, workspaceQuery } from "@/lib/queries"
import { previewRepoRef } from "@/lib/repo-ref"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useDocumentTitle } from "@/lib/use-document-title"
import { AnalysisCard } from "./analysis-card"
import { ArxivImportForm } from "./arxiv-import-form"
import { importErrorCopy, importRetryCopy, RETRYABLE_IMPORT_CODES } from "./import-copy"

// Imported papers: an arXiv paper fetched into a locked artifact, with its implementation
// and an agent-written analysis of that code. Kept from the Context console, where it used
// to live, as its own two pages: /papers/new imports one, /papers/$id follows it.

const route = getRouteApi("/papers/$id")

export function NewPaper() {
  useDocumentTitle("Import a paper")
  const { arxiv } = getRouteApi("/papers/new").useSearch()
  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader title="Import a paper" />
      <ArxivImportForm initialUrl={arxiv ?? ""} />
    </PageShell>
  )
}

export function PaperPending() {
  return (
    <PageShell width="wide" className="flex flex-col gap-5">
      <Skeleton className="h-7 w-64" />
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-32 w-full rounded-xl" />
    </PageShell>
  )
}

export function PaperPage() {
  const { id } = route.useParams()
  const { me } = useAuth()
  // An import on its way polls fast, so the page turns from "fetching" into the paper by
  // itself; a settled one stops.
  const { data: context, error } = useQuery({
    ...paperQuery(id),
    refetchInterval: (q) =>
      q.state.status === "error"
        ? false
        : importSettling(q.state.data?.import)
          ? IMPORT_POLL_MS
          : false,
    refetchIntervalInBackground: false,
  })
  useDocumentTitle(context?.name ?? "Paper")
  if (error && !context) {
    const status = error instanceof ApiError ? error.status : undefined
    return (
      <PageShell className="flex justify-center pt-16">
        <EmptyState
          icon={<Icon name="lock" strokeWidth={1.75} />}
          title={status === 404 || status === 403 ? "No such paper here" : "Couldn't load"}
          description={
            status === 404 || status === 403
              ? "It isn't in this workspace, or you can't see it."
              : "Something went wrong loading this paper. Try again in a moment."
          }
        />
      </PageShell>
    )
  }
  if (!context) return <PaperPending />
  if (!context.import)
    return (
      <PageShell className="flex justify-center pt-16">
        <EmptyState
          icon={<Icon name="lock" strokeWidth={1.75} />}
          title="Not an imported paper"
          description="This id belongs to something that was not imported from arXiv."
        />
      </PageShell>
    )
  return <ImportedConsole id={id} context={context} isOwner={context.created_by === me?.id} />
}

const IMPORT_POLL_MS = 3_000
/** The PAPER is on its way. Drives the whole-page "fetching from arXiv" panel, so it must
 *  never be true for a paper that is already here with its implementation still coming. */
const importInFlight = (status: string | undefined): boolean =>
  status === "pending" || status === "fetching"
/** Something is still arriving, paper or code, so keep asking. */
const importSettling = (imp: ContextDetail["import"] | undefined): boolean =>
  importInFlight(imp?.status) || imp?.code?.status === "pending"

/**
 * The paper's implementation. The repository's files live INSIDE the paper's artifact,
 * where an agent reading the paper reads them; this card is the only place a person meets
 * them, and what it offers is a link to the repository on its own host. There is
 * deliberately no file listing: the code is not a second document to browse here.
 */
function ImplementationCard({
  id,
  code,
  canManage,
}: {
  id: string
  code: NonNullable<NonNullable<ContextDetail["import"]>["code"]> | null
  canManage: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [url, setUrl] = useState("")
  const ref = previewRepoRef(url)
  const save = useApiMutation({
    mutationFn: (next: string | null) => api.setContextCode(id, next),
    success: "Fetching the implementation",
    invalidate: [paperQuery(id).queryKey],
    onSuccess: () => {
      setEditing(false)
      setUrl("")
    },
  })
  const remove = useApiMutation({
    mutationFn: () => api.setContextCode(id, null),
    success: "Implementation removed",
    invalidate: [paperQuery(id).queryKey],
  })
  if (!code && !canManage) return null
  const busy = save.isPending || remove.isPending
  return (
    <div className="rounded-xl border bg-card p-4" data-testid="console-code-panel">
      <SectionTitle as="h2">Implementation</SectionTitle>
      {code ? (
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            {code.status === "ready" ? (
              <>
                Stored inside this paper, where your agents read it beside the method. It is not
                browsable here; open the repository to read it yourself.
              </>
            ) : code.status === "failed" ? (
              <>Couldn't fetch this repository. {code.error ?? ""}</>
            ) : (
              <>Fetching this repository. The page updates itself.</>
            )}
          </p>
          {code.status === "ready" && code.commit && (
            <p
              className="font-mono text-2xs text-muted-foreground"
              title={code.commit}
              data-testid="console-code-commit"
            >
              at {code.commit.slice(0, 7)}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="outline" data-testid="console-code-open">
              <a href={code.url} target="_blank" rel="noreferrer">
                Open the repository ↗
              </a>
            </Button>
            {canManage && !editing && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="console-code-replace"
                  disabled={busy}
                  onClick={() => setEditing(true)}
                >
                  Replace
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="console-code-remove"
                  disabled={busy}
                  onClick={() => remove.mutate()}
                >
                  Remove
                </Button>
              </>
            )}
          </div>
        </div>
      ) : !editing ? (
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            Attach the public repository that implements this paper, and your agents can read the
            code beside the method.
          </p>
          <div>
            <Button
              size="sm"
              variant="outline"
              data-testid="console-code-attach"
              onClick={() => setEditing(true)}
            >
              Attach an implementation
            </Button>
          </div>
        </div>
      ) : null}
      {editing && (
        <div className="mt-2 flex flex-col gap-2">
          <Input
            data-testid="console-code-url"
            aria-label="Repository link"
            placeholder="https://github.com/owner/project"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && ref) save.mutate(ref.webUrl)
            }}
            className="font-mono"
          />
          <p
            role="status"
            data-testid="console-code-preview"
            className="font-mono text-2xs text-muted-foreground"
          >
            {url.trim() ? (ref ? ref.canonical : "Not a GitHub or GitLab repository") : " "}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              data-testid="console-code-save"
              disabled={!ref || busy}
              onClick={() => ref && save.mutate(ref.webUrl)}
            >
              Fetch it
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="console-code-cancel"
              onClick={() => {
                setEditing(false)
                setUrl("")
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// An imported paper's page. The paper is the whole point, so the page is its arrival (or
// its failure) and, once it is here, the paper card with the BibTeX to cite it, its
// implementation, and the analysis of that implementation.
function ImportedConsole({
  id,
  context,
  isOwner,
}: {
  id: string
  context: ContextDetail
  isOwner: boolean
}) {
  const imp = context.import
  const qc = useQueryClient()
  const nav = useNavigate()
  const { me } = useAuth()
  // Discard follows the delete route's gate: the creator, or a workspace owner.
  const { data: ws } = useQuery({ ...workspaceQuery(), staleTime: 60_000 })
  const canManage = isOwner || ws?.role === "owner"
  const retry = useApiMutation({
    mutationFn: () => api.retryContextImport(id),
    success: "Fetching from arXiv again",
    invalidate: [paperQuery(id).queryKey],
  })
  const discard = useApiMutation({
    mutationFn: () => api.deleteContext(id),
    success: "Paper removed",
    onSuccess: () => {
      qc.removeQueries({ queryKey: paperQuery(id).queryKey })
      nav({ to: "/" })
    },
  })
  // One artifact: the paper itself. `documents` names it too,
  // so either resolves; the manifest short id is the fallback while it is still fetching.
  const paper = context.documents?.find((d) => d.role === "paper") ??
    context.documents?.[0] ?? {
      short_id: context.manifest_short_id ?? "",
      title: context.name,
    }
  if (!imp) return null
  const inFlight = importInFlight(imp.status)
  const failed = imp.status === "failed" || imp.status === "dead"
  const code = imp.error?.code ?? null
  const retryable = imp.status === "dead" || (code !== null && RETRYABLE_IMPORT_CODES.has(code))
  const retryLine = importRetryCopy(imp.status, code)
  const actions = (
    <span className="flex flex-wrap items-center gap-2">
      {retryable && (
        <Button
          size="sm"
          variant="outline"
          data-testid="context-import-retry"
          disabled={retry.isPending}
          onClick={() => retry.mutate()}
        >
          Try again
        </Button>
      )}
      {canManage && (
        <Button
          size="sm"
          variant="ghost"
          data-testid="context-import-remove"
          disabled={discard.isPending}
          onClick={() => discard.mutate()}
        >
          Discard
        </Button>
      )}
    </span>
  )
  return (
    <PageShell width="wide" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <Icon name="lock" className="text-muted-foreground" />
          <h1 className="font-serif text-2xl font-medium tracking-tight text-foreground">
            {context.name}
          </h1>
        </div>
        <Eyebrow>
          Paper
          {imp.version != null && <> · v{imp.version}</>}
          {" · "}
          <a
            href={imp.url}
            target="_blank"
            rel="noreferrer"
            data-testid="console-arxiv-link"
            className="underline-offset-4 hover:underline"
          >
            arXiv:{imp.ref} ↗
          </a>
        </Eyebrow>
        {context.description && (
          <p className="max-w-2xl text-pretty text-sm text-muted-foreground">
            {context.description}
          </p>
        )}
      </div>

      {inFlight ? (
        <div data-testid="console-import-panel">
          <StatusPanel
            tone="warning"
            layout="inline"
            icon={<Spinner size="sm" tone="current" />}
            title="Fetching this paper from arXiv"
            description={
              <>
                Derive is downloading the LaTeX source and BibTeX. This usually takes under a
                minute; the page updates itself.
                {imp.imported_by === me?.id ? null : <> Imported by a teammate.</>}
              </>
            }
            action={canManage ? actions : undefined}
          />
        </div>
      ) : failed ? (
        <div data-testid="console-import-panel">
          <StatusPanel
            tone="danger"
            layout="inline"
            icon={<TriangleAlert />}
            title="Couldn't import this paper"
            description={
              <>
                {importErrorCopy(code, "The import failed.")}
                {retryLine ? ` ${retryLine}` : null}
                {/* The detail is ours, not the upstream's: which phase failed and what it
                    said. Shown for every failure, because without it "arXiv didn't
                    answer" is the only thing anyone debugging this ever sees, and it is
                    not always true. */}
                {imp.error?.detail ? (
                  <span
                    data-testid="console-import-detail"
                    className="mt-1 block font-mono text-2xs"
                  >
                    {imp.error.detail}
                  </span>
                ) : null}
              </>
            }
            action={actions}
          />
        </div>
      ) : (
        <section
          className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
          data-testid="console-import-panel"
        >
          <div className="rounded-xl border bg-card p-4">
            <SectionTitle as="h2">Paper</SectionTitle>
            {paper.short_id ? (
              <div className="mt-2 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 truncate text-sm font-medium text-foreground">
                    {paper.title ?? paper.short_id}
                  </span>
                  <Badge variant="outline" shape="pill">
                    arXiv
                  </Badge>
                </div>
                <p className="text-2xs text-muted-foreground">
                  Imported from arXiv and locked so it stays the published version. Comments are the
                  place for suggestions; the owner can unlock it from the paper's More menu.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button asChild size="sm" data-testid="console-paper-open">
                    <Link to="/artifacts/$ref" params={{ ref: paper.short_id }}>
                      Open the paper
                    </Link>
                  </Button>
                  {context.bibtex && (
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid="console-paper-copy-bibtex"
                      onClick={() =>
                        void copyText(context.bibtex ?? "", { success: "BibTeX copied" })
                      }
                    >
                      <CopyIcon /> Copy BibTeX
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                The paper bundle can't be resolved. Discard it and import it again.
              </p>
            )}
          </div>
          <div className="rounded-xl border bg-card p-4">
            <SectionTitle as="h2">Reading</SectionTitle>
            <p className="mt-2 text-sm text-muted-foreground">
              Agents read the paper like any page. To ask one about it, open the paper and use the
              Ask box in its margin.
            </p>
            {canManage && <div className="mt-3">{actions}</div>}
          </div>
          <div className="lg:col-span-2">
            <ImplementationCard id={id} code={imp.code ?? null} canManage={canManage} />
          </div>
          {imp.code && (
            <div className="lg:col-span-2">
              <AnalysisCard id={id} codeStatus={imp.code.status} />
            </div>
          )}
        </section>
      )}
    </PageShell>
  )
}

import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { TriangleAlert } from "lucide-react"
import { useEffect, useState } from "react"
import type { ContextAnalysis } from "@/api"
import { ConnectAgentButton, PromptBlock } from "@/components/shared/connect-agent"
import { LoadError } from "@/components/shared/load-error"
import { SectionTitle } from "@/components/shared/section-title"
import { Spinner } from "@/components/shared/spinner"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { contextAnalysisQuery } from "@/lib/queries"
import { ago } from "@/lib/time"
import { mdToHtml } from "../artifact/lib/markdown"
import {
  ANALYSIS_STATUS_BADGE,
  ANALYSIS_STATUS_LABEL,
  ANALYSIS_STATUS_ORDER,
  type AnalysisWait,
  analysisPollInterval,
  codeRefLabel,
  paperRefLabel,
} from "./analysis-view"

type Analysis = NonNullable<ContextAnalysis["analysis"]>
type CodeRef = Analysis["contributions"][number]["details"][number]["code"][number]
type PaperRef = Analysis["contributions"][number]["paper"][number]

/**
 * The paper-to-implementation analysis of an imported paper. Derive never writes it: a person
 * copies a prompt into their own agent, which reads the paper and the code and publishes the
 * map. So the card is that prompt until an analysis exists, and the analysis itself after, with
 * a second prompt to correct and extend it. Code references open on the repository's own host,
 * never here: the implementation is for agents to read, and the analysis only points at it.
 */
export function AnalysisCard({ id, codeStatus }: { id: string; codeStatus: string }) {
  const [wait, setWait] = useState<AnalysisWait | null>(null)
  const query = useQuery({
    ...contextAnalysisQuery(id),
    refetchInterval: (q) =>
      analysisPollInterval(wait, q.state.data?.analysis?.version ?? null, Date.now()),
    refetchIntervalInBackground: false,
  })
  const { data, isError, refetch } = query
  // The implementation arriving (or being replaced) changes what the card can offer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the code's status moves
  useEffect(() => {
    void refetch()
  }, [codeStatus])
  const startWaiting = () =>
    setWait({ since: Date.now(), version: data?.analysis?.version ?? null })

  return (
    <div className="rounded-xl border bg-card p-4" data-testid="console-analysis-panel">
      <SectionTitle as="h2">Paper-to-implementation analysis</SectionTitle>
      {isError ? (
        <LoadError
          layout="inline"
          className="mt-2"
          title="Couldn't load the analysis."
          testId="console-analysis-retry"
          onRetry={() => void refetch()}
        />
      ) : !data ? (
        <div className="mt-2">
          <Spinner size="sm" />
        </div>
      ) : data.state === "unavailable" ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Once this paper's implementation has arrived, an agent can map the paper to it.
        </p>
      ) : data.state === "restricted" ? (
        <p className="mt-2 text-sm text-muted-foreground">
          An agent has mapped this paper to its implementation, but the analysis isn't shared with
          you.
        </p>
      ) : data.state === "none" || !data.analysis ? (
        <NotConducted data={data} waiting={!!wait} onCopied={startWaiting} />
      ) : (
        <Report
          data={data}
          analysis={data.analysis}
          waiting={!!wait}
          onCopied={startWaiting}
          paperShortId={data.paper_short_id}
        />
      )}
    </div>
  )
}

function NotConducted({
  data,
  waiting,
  onCopied,
}: {
  data: ContextAnalysis
  waiting: boolean
  onCopied: () => void
}) {
  return (
    <div className="mt-2 flex flex-col gap-3" data-testid="console-analysis-none">
      <p className="text-sm text-muted-foreground">
        No analysis yet. An agent can read the paper and its code, then map each contribution and
        each detail of the method to the code that carries it out, and say where the code differs.
        It is kept here, and your agents read it before answering questions about the
        implementation.
      </p>
      {data.can_publish && data.prompts.start ? (
        <>
          <p className="text-2xs text-muted-foreground">To start it, copy this into your agent.</p>
          <PromptBlock
            text={data.prompts.start}
            testid="console-analysis-start-prompt"
            copyLabel="Copy the prompt"
            onCopied={onCopied}
          />
          <div className="flex flex-wrap items-center gap-3">
            <ConnectAgentButton testId="console-analysis-connect" size="sm" variant="ghost">
              Connect an agent first
            </ConnectAgentButton>
            {waiting && <Waiting />}
          </div>
        </>
      ) : (
        <p className="text-2xs text-muted-foreground">
          Someone who can edit in this workspace can have their agent start it.
        </p>
      )}
    </div>
  )
}

function Waiting() {
  return (
    <span className="flex items-center gap-2 text-2xs text-muted-foreground">
      <Spinner size="sm" tone="current" /> Waiting for your agent to publish it. This page updates
      itself.
    </span>
  )
}

function Report({
  data,
  analysis,
  waiting,
  onCopied,
  paperShortId,
}: {
  data: ContextAnalysis
  analysis: Analysis
  waiting: boolean
  onCopied: () => void
  paperShortId: string | null
}) {
  return (
    <div className="mt-2 flex flex-col gap-3" data-testid="console-analysis-report">
      {data.state === "stale" && (
        <StatusPanel
          tone="warning"
          layout="inline"
          icon={<TriangleAlert />}
          title="Made against an earlier version"
          description={`${data.stale_reasons.join(". ")}. Ask an agent to update it.`}
        />
      )}
      <Prose className="text-sm text-foreground" markdown={analysis.summary} />
      <div className="flex flex-wrap items-center gap-2">
        {ANALYSIS_STATUS_ORDER.map((status) => (
          <Badge key={status} variant={ANALYSIS_STATUS_BADGE[status]} shape="pill">
            {analysis.counts[status]} {ANALYSIS_STATUS_LABEL[status].toLowerCase()}
          </Badge>
        ))}
        <span className="text-2xs text-muted-foreground">
          v{analysis.version} · {analysis.agent ?? "an agent"} · {ago(analysis.updated_at)}
        </span>
      </div>
      <ol className="flex flex-col gap-3">
        {analysis.contributions.map((c, i) => (
          <li
            key={c.id}
            className="rounded-lg border p-3"
            data-testid="console-analysis-contribution"
          >
            <p className="text-sm font-medium text-foreground">
              {i + 1}. {c.title}
            </p>
            <Prose className="mt-1 text-sm text-muted-foreground" markdown={c.claim} />
            <PaperRefs refs={c.paper} paperShortId={paperShortId} />
            <ul className="mt-2 flex flex-col gap-2.5">
              {c.details.map((d) => (
                <li key={d.id} data-testid="console-analysis-detail">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-foreground">{d.title}</span>
                    <Badge variant={ANALYSIS_STATUS_BADGE[d.status]} shape="pill">
                      {ANALYSIS_STATUS_LABEL[d.status]}
                    </Badge>
                  </div>
                  <PaperRefs refs={d.paper} paperShortId={paperShortId} />
                  <CodeRefs refs={d.code} />
                  {d.notes && (
                    <Prose className="mt-1 text-2xs text-muted-foreground" markdown={d.notes} />
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      {analysis.unmapped.length > 0 && (
        <div>
          <p className="text-sm font-medium text-foreground">Code the paper does not describe</p>
          <ul className="mt-1 flex flex-col gap-1.5">
            {analysis.unmapped.map((u) => (
              <li key={u.id}>
                <CodeRefs refs={[u]} />
                <Prose className="text-2xs text-muted-foreground" markdown={u.notes} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {analysis.open_questions.length > 0 && (
        <div>
          <p className="text-sm font-medium text-foreground">Open questions</p>
          <ul className="mt-1 flex list-disc flex-col gap-1 pl-4">
            {analysis.open_questions.map((q) => (
              <li key={q.id}>
                <Prose className="text-sm text-muted-foreground" markdown={q.question} />
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild size="sm" variant="outline" data-testid="console-analysis-open">
          <Link to="/artifacts/$ref" params={{ ref: analysis.short_id }}>
            Open the analysis
          </Link>
        </Button>
        <span className="text-2xs text-muted-foreground">
          Its history and comments are on its page.
        </span>
      </div>
      {data.can_publish && data.prompts.update ? (
        <details className="rounded-lg border p-3" data-testid="console-analysis-update">
          <summary className="cursor-pointer text-sm text-foreground">
            Found something to correct or add? Copy this into your agent.
          </summary>
          <div className="mt-3 flex flex-col gap-2">
            <PromptBlock
              text={data.prompts.update}
              testid="console-analysis-update-prompt"
              copyLabel="Copy the prompt"
              onCopied={onCopied}
            />
            {waiting && <Waiting />}
          </div>
        </details>
      ) : (
        <p className="text-2xs text-muted-foreground">
          To suggest a correction, comment on the analysis.
        </p>
      )}
    </div>
  )
}

function Prose({ markdown, className }: { markdown: string; className?: string }) {
  return (
    <p
      className={className}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: mdToHtml escapes first, then adds inline markup only
      dangerouslySetInnerHTML={{ __html: mdToHtml(markdown) }}
    />
  )
}

function PaperRefs({ refs, paperShortId }: { refs: PaperRef[]; paperShortId: string | null }) {
  if (refs.length === 0) return null
  return (
    <p className="mt-1 text-2xs text-muted-foreground">
      Paper:{" "}
      {refs.map((r, i) => (
        <span key={`${r.section}:${r.label ?? ""}`}>
          {i > 0 && ", "}
          {paperShortId ? (
            <Link
              to="/artifacts/$ref"
              params={{ ref: paperShortId }}
              className="underline-offset-4 hover:underline"
            >
              {paperRefLabel(r)}
            </Link>
          ) : (
            paperRefLabel(r)
          )}
        </span>
      ))}
    </p>
  )
}

function CodeRefs({ refs }: { refs: CodeRef[] }) {
  if (refs.length === 0) return null
  return (
    <ul className="mt-1 flex flex-col gap-0.5">
      {refs.map((r) => (
        <li key={`${r.path}:${r.symbol ?? ""}:${r.lines ?? ""}`} className="font-mono text-2xs">
          {r.href ? (
            <a
              href={r.href}
              target="_blank"
              rel="noreferrer"
              className="text-foreground underline-offset-4 hover:underline"
            >
              {codeRefLabel(r)} ↗
            </a>
          ) : (
            codeRefLabel(r)
          )}
          {!r.pinned && (
            <span className="ml-1 text-muted-foreground">(not pinned to a commit)</span>
          )}
        </li>
      ))}
    </ul>
  )
}

import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { api, type WorkflowRunSummary } from "@/api"
import { RunReceipt, runStatusLabel, runStatusTone } from "@/components/shared/run-receipt"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { StatusBadge } from "@/components/shared/status-badge"
import {
  compactWorkflowReceiptText,
  workflowAttemptRoute,
  workflowDeliveryLabel,
  workflowRunSummary,
} from "./workflow-run-presentation"

const terminal = new Set<WorkflowRunSummary["status"]>(["succeeded", "failed", "cancelled"])

type WorkflowAttempt = WorkflowRunSummary["attempts"][number]

const attemptKindLabel = (kind: WorkflowAttempt["kind"]): string => {
  if (kind === "context") return "Agent step"
  if (kind === "human") return "Human pause"
  return "Terminal step"
}

const ReceiptField = ({ label, value }: { label: string; value: string | null }) => {
  if (!value) return null
  return (
    <div className="grid gap-0.5 text-2xs sm:grid-cols-[5rem_minmax(0,1fr)] sm:gap-2">
      <dt className="font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{compactWorkflowReceiptText(value)}</dd>
    </div>
  )
}

const WorkflowAttemptTimeline = ({ attempts }: { attempts: WorkflowAttempt[] }) => (
  <ol className="grid gap-2" aria-label="Steps taken in this run">
    {attempts.map((attempt) => {
      const route = workflowAttemptRoute(attempt)
      return (
        <li key={attempt.id} className="rounded-lg border border-border-soft bg-background p-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={runStatusTone(attempt.status)} shape="pill">
              {runStatusLabel(attempt.status)}
            </StatusBadge>
            <span className="break-all font-mono text-xs font-medium text-foreground">
              {attempt.nodeId}
            </span>
            <span className="text-2xs text-muted-foreground">
              {attemptKindLabel(attempt.kind)} · attempt {attempt.attempt}
            </span>
          </div>
          <dl className="mt-2 grid gap-1.5">
            {attempt.kind === "human" && attempt.status === "waiting" ? (
              <ReceiptField label="Waiting for" value="A person's decision" />
            ) : null}
            <ReceiptField label="Route" value={route} />
            <ReceiptField label="Because" value={attempt.routeBasis} />
            <ReceiptField label="Error" value={attempt.error} />
            {attempt.resultArtifactId ? (
              <div className="grid gap-0.5 text-2xs sm:grid-cols-[5rem_minmax(0,1fr)] sm:gap-2">
                <dt className="font-medium text-muted-foreground">Result</dt>
                <dd>
                  <Link
                    to="/artifacts/$ref"
                    params={{ ref: attempt.resultArtifactId }}
                    className="font-medium text-primary hover:underline"
                    aria-label={`Open result from ${attempt.nodeId}`}
                  >
                    Open Artifact
                  </Link>
                </dd>
              </div>
            ) : null}
          </dl>
        </li>
      )
    })}
  </ol>
)

export function WorkflowRunHistory({
  shortId,
  diagramId,
  diagramTitle,
}: {
  shortId: string
  diagramId: string
  diagramTitle: string
}) {
  const query = useQuery({
    queryKey: ["workflow-runs", shortId, diagramId] as const,
    queryFn: () => api.workflowRuns(shortId, diagramId),
    refetchInterval: (current) =>
      current.state.data?.runs.some((run) => !terminal.has(run.status)) ? 5000 : false,
  })

  if (query.isPending) {
    return (
      <div className="px-4 pb-4 text-xs text-muted-foreground sm:px-5" role="status">
        Checking recent runs…
      </div>
    )
  }
  if (query.isError) {
    return (
      <div className="px-4 pb-4 text-xs text-destructive sm:px-5">Couldn’t load recent runs.</div>
    )
  }
  if (query.data.runs.length === 0) {
    return (
      <div className="px-4 pb-4 text-xs text-muted-foreground sm:px-5">
        No runs yet. Starting this workflow creates a separate, version-pinned run.
      </div>
    )
  }

  return (
    <section className="px-4 pb-4 sm:px-5" data-testid="workflow-runs">
      <Eyebrow as="div">Recent runs</Eyebrow>
      <div className="mt-2 grid gap-2">
        {query.data.runs.map((run, index) => (
          <RunReceipt
            key={run.id}
            id={run.id}
            status={run.status}
            title={diagramTitle}
            summary={workflowRunSummary(run)}
            facts={[
              `Definition v${run.workflowVersion}`,
              workflowDeliveryLabel(run),
              run.attempts.length === 0
                ? "No steps started"
                : `${run.attempts.length} step${run.attempts.length === 1 ? "" : "s"} recorded`,
            ]}
            createdAt={run.createdAt}
            defaultOpen={index === 0}
            testId={`workflow-run-${run.id}`}
          >
            {run.attempts.length > 0 ? (
              <WorkflowAttemptTimeline attempts={run.attempts} />
            ) : undefined}
          </RunReceipt>
        ))}
      </div>
    </section>
  )
}

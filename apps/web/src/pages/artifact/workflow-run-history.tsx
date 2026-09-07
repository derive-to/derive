import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { api, type WorkflowRunSummary } from "@/api"
import {
  type RunDisplayStatus,
  RunReceipt,
  runStatusLabel,
  runStatusTone,
} from "@/components/shared/run-receipt"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { StatusBadge } from "@/components/shared/status-badge"
import { refFor } from "./parse-ref"
import { workflowGithubReceipt } from "./workflow-github-presentation"
import {
  compactWorkflowReceiptText,
  workflowAttemptRoute,
  workflowDeliveryLabel,
  workflowRunSummary,
} from "./workflow-run-presentation"

const terminal = new Set<string>(["succeeded", "failed", "cancelled", "timed_out"])

type WorkflowAttempt = WorkflowRunSummary["attempts"][number]
type WorkflowActivity = WorkflowRunSummary["activity"][number]

const attemptKindLabel = (kind: WorkflowAttempt["kind"]): string => {
  if (kind === "context") return "Context step"
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

const activityRoleLabel = (role: WorkflowActivity["role"]): string => {
  if (role === "evidence") return "Evidence"
  if (role === "input") return "Input"
  return "Output"
}

const WorkflowActivityTimeline = ({ activity }: { activity: WorkflowActivity[] }) => (
  <div className="mb-3 rounded-lg border border-border-soft bg-background p-3">
    <div className="flex items-baseline justify-between gap-3">
      <span className="font-medium text-foreground">Activity</span>
      <span className="text-2xs text-muted-foreground">Completion is unconfirmed</span>
    </div>
    <ol className="mt-2 grid gap-2" aria-label="Artifacts observed during this run">
      {activity.map((item) => {
        const base = refFor({ short_id: item.artifactShortId, title: item.artifactTitle })
        return (
          <li
            key={item.id}
            className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 rounded-md border border-border-soft px-2.5 py-2"
          >
            <span className="mt-1 size-2 rounded-full bg-success" aria-hidden="true" />
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs">
                <span className="font-medium text-foreground">{activityRoleLabel(item.role)}</span>
                <Link
                  to="/artifacts/$ref"
                  params={{ ref: `${base}@v${item.artifactVersion}` }}
                  className="min-w-0 truncate font-medium text-primary hover:underline"
                  data-testid={`workflow-activity-artifact-${item.id}`}
                >
                  {item.artifactTitle ?? item.artifactShortId} · v{item.artifactVersion}
                </Link>
              </div>
              <p className="mt-0.5 text-2xs text-muted-foreground">
                Observed at {item.nodeId} · attempt {item.attempt}
              </p>
            </div>
          </li>
        )
      })}
    </ol>
  </div>
)

const GithubExecutionReceipt = ({ run }: { run: WorkflowRunSummary }) => {
  const receipt = workflowGithubReceipt(run)
  if (!receipt) return null
  return (
    <div className="mb-3 min-w-0 rounded-lg border border-border-soft bg-background p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">GitHub Actions receipt</span>
        {receipt.runUrl && receipt.runId ? (
          <a
            href={receipt.runUrl}
            target="_blank"
            rel="noreferrer"
            className="break-all text-xs font-medium text-primary hover:underline"
            data-testid={`workflow-github-run-link-${run.id}`}
          >
            Run #{receipt.runId}
          </a>
        ) : (
          <span className="text-xs text-muted-foreground">Awaiting GitHub run ID</span>
        )}
      </div>
      <dl className="mt-2 grid gap-1.5">
        <ReceiptField label="Repository" value={receipt.repository} />
        <ReceiptField label="Adapter" value={`${receipt.workflow} · ${receipt.ref}`} />
        <ReceiptField
          label="GitHub"
          value={
            receipt.githubConclusion ??
            receipt.githubStatus ??
            (receipt.exchangedAt ? "OIDC authenticated" : "Dispatched")
          }
        />
        <ReceiptField
          label="Attempt"
          value={receipt.runAttempt === null ? null : String(receipt.runAttempt)}
        />
        <ReceiptField label="Error" value={receipt.error} />
      </dl>
      <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
        Dispatch proves only that GitHub accepted the request. Completion above reflects the
        correlated GitHub job and Derive’s graph receipts.
      </p>
    </div>
  )
}

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
            status={run.status as RunDisplayStatus}
            title={diagramTitle}
            summary={workflowRunSummary(run)}
            facts={[
              `Definition v${run.workflowVersion}`,
              workflowDeliveryLabel(run),
              run.attempts.length === 0
                ? "No steps started"
                : `${run.attempts.length} step${run.attempts.length === 1 ? "" : "s"} recorded`,
              `${run.activity.length} artifact${run.activity.length === 1 ? "" : "s"} observed`,
            ]}
            createdAt={run.createdAt}
            defaultOpen={index === 0}
            testId={`workflow-run-${run.id}`}
          >
            {workflowGithubReceipt(run) || run.attempts.length > 0 || run.activity.length > 0 ? (
              <>
                <GithubExecutionReceipt run={run} />
                {run.activity.length > 0 ? (
                  <WorkflowActivityTimeline activity={run.activity} />
                ) : null}
                {run.attempts.length > 0 ? (
                  <WorkflowAttemptTimeline attempts={run.attempts} />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {run.activity.length > 0
                      ? "Activity was observed, but no step receipt has been recorded yet."
                      : "No step receipt has been recorded yet."}
                  </p>
                )}
              </>
            ) : undefined}
          </RunReceipt>
        ))}
      </div>
    </section>
  )
}

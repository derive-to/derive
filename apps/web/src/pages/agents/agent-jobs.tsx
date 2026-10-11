import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { type Agent, type AgentDetail, api, type Job } from "@/api"
import { LoadError } from "@/components/shared/load-error"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { accountsQuery, agentJobsQuery, agentQuery, jobQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useJobEvents } from "@/lib/use-job-events"
import { cn } from "@/lib/utils"
import {
  cronLabel,
  failureOf,
  firstLine,
  JOB_ICON,
  machineOf,
  schedulesOf,
  took,
  when,
} from "./format"
import { Group, Meta, RowLine, Time } from "./rows"
import { AgentRowsSkeleton } from "./skeleton"
import { TaskReceipt, TaskUsage } from "./task-usage"

const first = (name: string | undefined) => name?.trim().split(/\s+/)[0] || undefined

/** The one line that says why this agent's jobs will not start, or null when they will.
 *  `noAccount` is true only when the viewer can see that no model account would resolve. */
export function warningFor(
  agent: Pick<Agent, "paused" | "machine" | "seen_at" | "created_by">,
  names: Map<string, string>,
  noAccount = false,
): string | null {
  if (agent.paused) return "This agent is paused. New tasks wait until you resume it in Settings."
  // Only a Derive machine needs a stored account; a runner on someone's own machine falls back
  // to the login on that machine.
  if (noAccount && agent.machine === "derive")
    return "Connect a model account in Settings to start cloud tasks."
  if (agent.machine === "derive") return null
  if (!agent.seen_at) return "Its runner has never checked in. Tasks wait until it does."
  const mark = machineOf(agent, names)
  if (mark.on) return null
  return `${mark.label.replace(/, off$/, "")} was last seen ${when(agent.seen_at)}. Tasks wait while it is off.`
}

// The Jobs tab: what the agent does, what would stop it, where it runs, then every job it has
// taken, newest first, one line each.
export function AgentJobs({
  agent,
  names,
  meId,
  usage = false,
}: {
  agent: AgentDetail
  names: Map<string, string>
  meId: string
  usage?: boolean
}) {
  // Job events keep this live; the slow poll catches teammates' asks, which send you nothing.
  useJobEvents()
  const jobs = useInfiniteQuery({ ...agentJobsQuery(agent.id), refetchInterval: 10_000 })
  useQuery({ ...agentQuery(agent.id), refetchInterval: 10_000 })
  const warning = warningFor(agent, names, useNoAccount(agent, meId))
  const schedules = schedulesOf(agent.triggers)
  const rows = jobs.data?.pages.flatMap((p) => p.jobs) ?? []

  return (
    <div className="flex flex-col gap-9">
      {warning && (
        <p data-testid="agent-warning" role="status" className="text-sm text-warning">
          {warning}
        </p>
      )}
      {schedules.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {schedules.map((t) => `${cronLabel(t.cron ?? "")} · ${t.tz ?? "UTC"}`).join(", ")}
        </p>
      )}
      {jobs.isError ? (
        <LoadError
          title="Couldn’t load tasks."
          testId="agent-jobs-retry"
          onRetry={() => void jobs.refetch()}
        />
      ) : jobs.isPending ? (
        <AgentRowsSkeleton rows={3} />
      ) : usage ? (
        <TaskUsage jobs={rows} />
      ) : rows.length === 0 ? (
        <p data-testid="agent-jobs-empty" className="text-base text-muted-foreground">
          Ready for its first task.
        </p>
      ) : (
        <Group label="Tasks" testId="agent-jobs">
          {rows.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              agent={agent}
              names={names}
              canSteer={agent.can_manage || (job.asked_by === meId && agent.can_ask)}
            />
          ))}
          {jobs.hasNextPage && (
            <button
              type="button"
              data-testid="agent-jobs-more"
              disabled={jobs.isFetchingNextPage}
              onClick={() => void jobs.fetchNextPage()}
              className="self-start pt-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              Older tasks
            </button>
          )}
        </Group>
      )}
    </div>
  )
}

/** Whether the viewer can tell that no model account would resolve for this agent's jobs.
 *  Only its creator can: the fallback is the creator's own account, then a shared one, and
 *  nobody else sees the creator's accounts. */
function useNoAccount(agent: AgentDetail, meId: string): boolean {
  const mine = agent.machine === "derive" && !agent.account_id && agent.created_by === meId
  const accounts = useQuery({ ...accountsQuery(), enabled: mine })
  if (!mine || !accounts.data) return false
  return !accounts.data.some(
    (a) => a.provider === (agent.provider === "codex" ? "codex" : "claude") && (a.mine || a.shared),
  )
}

function taskStatus(job: Job, agent: Agent): string {
  if (job.status === "succeeded") return "Done"
  if (job.status === "needs_you") return "Needs you"
  if (job.status === "failed" || job.status === "lost") return "Failed"
  if (job.status === "cancelled") return "Stopped"
  if (job.status === "queued") return agent.paused ? "Paused" : "Queued"
  if (job.machine_phase === "stopping") return "Saving files"
  return "Running"
}

function detailOf(job: Job, agent: Agent): string | undefined {
  if (job.status === "needs_you") return job.needs?.question
  if (job.status === "failed" || job.status === "lost") return failureOf(job) ?? undefined
  if (job.status === "cancelled") return "Stopped before completion"
  if (job.status === "queued" && agent.runtime?.phase === "creating")
    return "Getting its sandbox ready…"
  if (job.status === "queued" && agent.runtime?.phase === "provisioning")
    return "Setting up its tools…"
  if (job.status === "queued")
    return agent.paused ? "Resume this agent in Settings to start" : "Waiting for its turn"
  if (job.status === "running" && job.machine_phase === "starting") return "Starting its sandbox…"
  if (job.status === "running" && ["ready", "launching"].includes(job.machine_phase ?? ""))
    return "Starting the task…"
  if (job.status === "running" && job.machine_phase === "stopping") return "Saving its files…"
  if (job.status === "succeeded") return job.result.effects?.[0]?.label
  return undefined
}

export function JobRow({
  job,
  agent,
  names,
  canSteer,
}: {
  job: Job
  agent: Agent
  names: Map<string, string>
  canSteer: boolean
}) {
  const [open, setOpen] = useState(false)
  const invalidate = [["jobs"]]
  const cancel = useApiMutation({ mutationFn: () => api.cancelJob(job.id), invalidate })
  const retry = useApiMutation({ mutationFn: () => api.retryJob(job.id), invalidate })
  const needs = job.status === "needs_you"
  const failed = job.status === "failed" || job.status === "lost"
  const asker =
    job.kind === "scheduled" ? "Schedule" : job.asked_by ? first(names.get(job.asked_by)) : null

  return (
    <div
      data-testid={`job-${job.id}`}
      data-status={job.status}
      className={cn(
        "border-b border-border last:border-b-0",
        needs && "-mx-3 my-0.5 rounded-lg border-b-0 bg-warning/10 px-3",
      )}
    >
      <div className="flex min-h-18 flex-wrap items-center gap-x-3.5 gap-y-2 py-3 text-base">
        <button
          type="button"
          data-testid={`job-row-${job.id}`}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex min-h-10 min-w-0 flex-1 basis-56 items-center gap-3.5 text-left"
        >
          <RowLine
            icon={JOB_ICON[job.status]}
            tone={needs ? "warning" : failed ? "destructive" : undefined}
            title={firstLine(job.instruction)}
            detail={detailOf(job, agent)}
          />
        </button>
        <Meta>
          <span
            className={cn(
              "text-sm",
              needs && "text-warning",
              failed && "text-destructive",
              job.status === "succeeded" && "text-success",
            )}
          >
            {taskStatus(job, agent)}
          </span>
          {asker && <span className="max-sm:hidden">{asker}</span>}
          {job.report_short_id && (
            <Link
              to="/artifacts/$ref"
              params={{ ref: job.report_short_id }}
              data-testid={`job-report-link-${job.id}`}
              className="font-medium text-foreground hover:underline"
            >
              Report
            </Link>
          )}
          {canSteer && (job.status === "running" || job.status === "queued" || needs) && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-testid={`job-cancel-${job.id}`}
              loading={cancel.isPending}
              onClick={() => cancel.mutate()}
              className="text-muted-foreground"
            >
              Cancel
            </Button>
          )}
          {canSteer && failed && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-testid={`job-retry-${job.id}`}
              loading={retry.isPending}
              onClick={() => retry.mutate()}
            >
              Retry
            </Button>
          )}
          {job.status === "running" && job.started_at ? (
            <Time>{took(job.started_at)}</Time>
          ) : job.status === "succeeded" && job.started_at ? (
            <>
              <Time>{took(job.started_at, job.finished_at)}</Time>
              <Time>{when(job.finished_at ?? job.updated_at)}</Time>
            </>
          ) : (
            <Time>{when(job.updated_at)}</Time>
          )}
        </Meta>
      </div>
      {needs && canSteer && <AnswerBox job={job} />}
      {open && (
        <>
          <p className="mb-4 rounded-lg bg-secondary/40 p-3 text-sm whitespace-pre-wrap">
            {job.instruction}
          </p>
          <TaskReceipt job={job} />
          <Transcript id={job.id} agentName={agent.name} names={names} />
        </>
      )}
    </div>
  )
}

/** Whether this person may answer, cancel, or retry a job: the agent's manager, or its asker
 *  while they may still ask it (canSteerJob). Reads the agent once (shared with its page). */
export function useCanSteer(job: Job | undefined, meId: string | undefined): boolean {
  const agent = useQuery({
    ...agentQuery(job?.agent_id ?? ""),
    enabled: !!job && !!meId && job.agent_id !== "derive",
  })
  if (job?.agent_id === "derive") return job.asked_by === meId
  if (!job || !meId || !agent.data) return false
  return agent.data.can_manage || (job.asked_by === meId && agent.data.can_ask)
}

/** A needs-you job's question, answered here: one of its options, or in words. */
export function AnswerBox({ job }: { job: Job }) {
  const [text, setText] = useState("")
  const answer = useApiMutation({
    mutationFn: (a: { text?: string; option?: string }) =>
      api.answerJob(job.id, {
        ...a,
        ...(job.needs?.question_id ? { question_id: job.needs.question_id } : {}),
      }),
    invalidate: [["jobs"]],
    onSuccess: () => setText(""),
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (text.trim()) answer.mutate({ text: text.trim() })
  }
  const options = job.needs?.options ?? []
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 pb-3 pl-8">
      {options.map((o, i) => (
        <Button
          key={o}
          type="button"
          variant="outline"
          size="sm"
          data-testid={`job-option-${job.id}-${i}`}
          disabled={answer.isPending}
          onClick={() => answer.mutate({ option: o })}
          className="bg-card"
        >
          {o}
        </Button>
      ))}
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={options.length ? "Or answer in words" : "Answer"}
        aria-label="Answer"
        data-testid={`job-answer-${job.id}`}
        className="h-8 max-w-sm min-w-48 flex-1 bg-card"
      />
      <Button
        type="submit"
        size="sm"
        data-testid={`job-answer-send-${job.id}`}
        disabled={!text.trim() || answer.isPending}
        loading={answer.isPending}
      >
        Send
      </Button>
    </form>
  )
}

/** The job's transcript and what it made, read when its row is opened. */
function Transcript({
  id,
  agentName,
  names,
}: {
  id: string
  agentName: string
  names: Map<string, string>
}) {
  const q = useQuery({
    ...jobQuery(id),
    refetchInterval: (query) =>
      ["queued", "running", "needs_you"].includes(query.state.data?.status ?? "") ? 5_000 : false,
  })
  if (q.isError)
    return (
      <LoadError
        layout="inline"
        title="Couldn’t load this job."
        testId={`job-transcript-retry-${id}`}
        onRetry={() => void q.refetch()}
        className="mb-3"
      />
    )
  if (q.isPending)
    return (
      <div className="flex flex-col gap-2 pb-4 pl-8">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    )
  const effects = q.data.result.effects ?? []
  return (
    <div data-testid={`job-transcript-${id}`} className="flex max-w-2xl flex-col gap-4 pb-5 pl-8">
      {q.data.messages.map((m) => (
        <div key={m.id} className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              {m.author_kind === "agent" ? agentName : (first(names.get(m.author_id)) ?? "Someone")}
            </span>
            <Time>{when(m.created_at)}</Time>
          </div>
          <p
            className={cn(
              "text-base leading-relaxed whitespace-pre-wrap",
              m.progress ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {m.body_md}
          </p>
        </div>
      ))}
      {(effects.length > 0 || q.data.report_short_id) && (
        <div className="flex flex-wrap gap-2">
          {q.data.report_short_id && (
            <Link
              to="/artifacts/$ref"
              params={{ ref: q.data.report_short_id }}
              data-testid={`job-report-${id}`}
              className="rounded-lg border border-border px-2.5 py-1.5 text-sm font-medium hover:bg-secondary"
            >
              Report
            </Link>
          )}
          {effects.map((e, i) =>
            e.kind === "page" && e.ref ? (
              <Link
                key={`${e.kind}-${e.ref}-${e.label}`}
                to="/artifacts/$ref"
                params={{ ref: e.ref }}
                data-testid={`job-effect-${id}-${i}`}
                className="rounded-lg border border-border px-2.5 py-1.5 text-sm hover:bg-secondary"
              >
                {e.label}
              </Link>
            ) : e.url && /^https?:\/\//i.test(e.url) ? (
              <a
                key={`${e.kind}-${e.url}-${e.label}`}
                href={e.url}
                target="_blank"
                rel="noreferrer"
                data-testid={`job-effect-${id}-${i}`}
                className="rounded-lg border border-border px-2.5 py-1.5 text-sm hover:bg-secondary"
              >
                {e.label}
              </a>
            ) : (
              <span
                key={`${e.kind}-${e.label}`}
                className="rounded-lg border border-border px-2.5 py-1.5 text-sm"
              >
                {e.label}
              </span>
            ),
          )}
        </div>
      )}
    </div>
  )
}

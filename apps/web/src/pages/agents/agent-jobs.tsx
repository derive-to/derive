import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { type FormEvent, type ReactNode, useRef, useState } from "react"
import {
  type Agent,
  type AgentDetail,
  type AgentTrigger,
  api,
  type Connection,
  type Job,
} from "@/api"
import { Icon } from "@/components/icons"
import { LoadError } from "@/components/shared/load-error"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  accountsQuery,
  agentConnectionsQuery,
  agentJobsQuery,
  agentQuery,
  jobQuery,
} from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useJobEvents } from "@/lib/use-job-events"
import { cn } from "@/lib/utils"
import { mdToHtml } from "../artifact/lib/markdown"
import {
  askedLine,
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
  broken: string[] = [],
): string | null {
  if (agent.paused) return "This agent is paused. New tasks wait until you resume it in Settings."
  if (broken.length) return `${broken.join(", ")} needs to reconnect. Open Sources in Settings.`
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
  const warning = warningFor(
    agent,
    names,
    useNoAccount(agent, meId),
    useBrokenSources(agent, agent.can_manage),
  )
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
              canAsk={agent.can_ask}
              canSchedule={agent.can_manage}
              triggers={agent.triggers}
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

/** The names of this agent's sources and secrets that are no longer active, read with the
 *  same request its Settings tab uses. Only a manager can see them, so only a manager asks. */
function useBrokenSources(agent: AgentDetail, enabled: boolean): string[] {
  const used = agent.connection_ids.length > 0 || Object.keys(agent.environment).length > 0
  const conns = useQuery({ ...agentConnectionsQuery(), enabled: enabled && used })
  if (!conns.data) return []
  const byId = new Map(conns.data.map((c) => [c.id, c]))
  const broken: string[] = []
  for (const id of agent.connection_ids) {
    const c = byId.get(id)
    if (c && c.status !== "active") broken.push(sourceName(c))
  }
  for (const [name, id] of Object.entries(agent.environment)) {
    const c = byId.get(id)
    if (c?.status !== "active") broken.push(name)
  }
  return broken
}

/** What a source is called in the product: the MCP server's host, or the integration's name. */
export const sourceName = (c: Connection): string =>
  c.kind === "mcp" && c.base_url ? c.base_url.replace(/^https?:\/\//, "") : c.toolkit

/** The first sentence of a question, for the one line a person scans. */
export function gistOf(question: string): string {
  const one = question.trim().replace(/\s+/g, " ")
  const m = /^(.{12,}?[.?!])(\s|$)/.exec(one)
  const first = m?.[1] ?? one
  return first.length > 140 ? `${first.slice(0, 139).trimEnd()}…` : first
}

/** One open question, built for triage. Closed: one line (the question's first sentence),
 *  how long it has been asked, the report, and Dismiss. Open: the transcript (what was asked,
 *  what the agent found), the whole question, its choices as buttons, and a line to answer. */
export function NeedsRow({
  job,
  canSteer,
  title,
  agentName,
  names,
  below,
  defaultOpen = false,
}: {
  job: Job
  canSteer: boolean
  /** Shown before the question where the list spans agents (the inbox). */
  title?: ReactNode
  agentName: string
  names: Map<string, string>
  /** Always under the question: a link to the page a review waits on. */
  below?: ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const asked = askedLine(job)
  const question = job.needs?.question ?? job.instruction
  const gist = gistOf(question)
  const dismiss = useApiMutation({
    mutationFn: () => api.cancelJob(job.id),
    invalidate: [["jobs"]],
  })
  return (
    <div
      data-testid={`job-${job.id}`}
      data-status={job.status}
      className="-mx-3 my-0.5 flex flex-col gap-3 rounded-lg bg-warning/10 px-3 py-3"
    >
      <div className="flex items-center gap-3.5">
        <button
          type="button"
          data-testid={`job-row-${job.id}`}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-3.5 text-left"
        >
          <Icon
            name="job-needs-you"
            size={18}
            strokeWidth={1.75}
            className="shrink-0 text-warning"
          />
          <span className="flex min-w-0 flex-1 items-baseline gap-2.5 text-base whitespace-nowrap">
            {title && <span className="shrink-0 font-medium text-foreground">{title}</span>}
            <span className={cn("truncate text-foreground", open && "whitespace-normal")}>
              {open ? question : gist}
            </span>
          </span>
        </button>
        <Meta>
          {asked && <span>{asked}</span>}
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
          <Time>{when(job.updated_at)}</Time>
          {canSteer && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-testid={`job-dismiss-${job.id}`}
              loading={dismiss.isPending}
              onClick={() => dismiss.mutate()}
              className="text-muted-foreground"
            >
              Dismiss
            </Button>
          )}
        </Meta>
      </div>
      {below}
      {open && <Transcript id={job.id} agentName={agentName} names={names} />}
      {open && canSteer && <AnswerBox job={job} />}
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
  if (job.status === "queued") {
    if (agent.paused) return "Paused"
    if (["creating", "provisioning", "stopping"].includes(agent.runtime?.phase ?? ""))
      return "Getting ready"
    if (agent.runtime?.phase === "failed") return "Retrying setup"
    return "Queued"
  }
  if (job.machine_phase === "starting") return "Starting"
  if (job.machine_phase === "stopping") return "Saving files"
  return "Running"
}

function detailOf(job: Job, agent: Agent): string | undefined {
  if (job.status === "needs_you") return job.needs?.question
  if (job.status === "failed" || job.status === "lost") return failureOf(job) ?? undefined
  if (job.status === "cancelled") return "Stopped before completion"
  if (job.status === "queued" && agent.runtime?.phase === "creating")
    return "Preparing its first sandbox. This can take a few minutes."
  if (job.status === "queued" && agent.runtime?.phase === "provisioning")
    return "Installing its tools. Your task starts when setup finishes."
  if (job.status === "queued" && agent.runtime?.phase === "stopping")
    return "Saving the sandbox so it is ready for your task."
  if (job.status === "queued" && agent.runtime?.phase === "failed")
    return "Sandbox setup did not finish. Derive will try again."
  if (job.status === "queued")
    return agent.paused ? "Resume this agent in Settings to start" : "Waiting for its turn"
  if (job.status === "running" && job.machine_phase === "starting") return "Starting its sandbox…"
  if (job.status === "running" && ["ready", "launching"].includes(job.machine_phase ?? ""))
    return "Starting the task…"
  if (job.status === "running" && job.machine_phase === "stopping") return "Saving its files…"
  if (job.status === "succeeded" && job.machine_phase === "stopping")
    return "Your result is ready. Stopping compute and collecting its receipt."
  if (job.status === "succeeded") return job.result.effects?.[0]?.label
  return undefined
}

export function JobRow({
  job,
  agent,
  names,
  canSteer,
  canAsk = false,
  canSchedule = false,
  triggers = [],
}: {
  job: Job
  agent: Agent
  names: Map<string, string>
  canSteer: boolean
  canAsk?: boolean
  canSchedule?: boolean
  triggers?: AgentTrigger[]
}) {
  const [open, setOpen] = useState(false)
  const invalidate = [["jobs"]]
  const cancel = useApiMutation({ mutationFn: () => api.cancelJob(job.id), invalidate })
  const retry = useApiMutation({ mutationFn: () => api.retryJob(job.id), invalidate })
  const repeatKey = useRef(crypto.randomUUID())
  const [repeated, setRepeated] = useState(false)
  const [daily, setDaily] = useState(false)
  const [time, setTime] = useState("09:00")
  const repeat = useApiMutation({
    errorToast: false,
    mutationFn: () =>
      api.askAgent(agent.id, job.instruction, undefined, { dedupe_key: repeatKey.current }),
    invalidate,
    onSuccess: () => {
      setRepeated(true)
    },
  })
  const schedule = useApiMutation({
    errorToast: false,
    mutationFn: async () => {
      const [hour, minute] = time.split(":").map(Number)
      const cron = `${minute} ${hour} * * *`
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      // Reconcile a lost response before retrying so we do not add a second schedule.
      const current = await api.getAgent(agent.id)
      const saved = current.triggers.find(
        (t) => t.cron === cron && t.tz === tz && t.instruction === job.instruction,
      )
      return saved
        ? saved.enabled
          ? saved
          : api.updateTrigger(saved.id, { enabled: true })
        : api.addTrigger(agent.id, { cron, tz, instruction: job.instruction })
    },
    invalidate: [["agents"]],
    onSuccess: () => setDaily(false),
  })
  const scheduled = triggers.some(
    (t) => t.kind === "schedule" && t.enabled && t.instruction === job.instruction,
  )
  const needs = job.status === "needs_you"
  const failed = job.status === "failed" || job.status === "lost"
  const detail = detailOf(job, agent)
  const asker =
    job.kind === "scheduled" ? "Schedule" : job.asked_by ? first(names.get(job.asked_by)) : null

  return (
    <div
      data-testid={`job-${job.id}`}
      data-status={job.status}
      className={cn(
        "border-b border-border transition-colors motion-reduce:transition-none last:border-b-0",
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
            detail={detail && <span className="block whitespace-normal">{detail}</span>}
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
          {asker && <span>{asker}</span>}
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
          <Transcript id={job.id} agentName={agent.name} names={names} />
          {job.status === "succeeded" && (canAsk || canSchedule) && (
            <div className="flex flex-col gap-3 pb-4">
              <div className="flex flex-wrap items-center gap-2">
                {canAsk && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid={`job-repeat-${job.id}`}
                    loading={repeat.isPending}
                    disabled={repeat.isPending || repeated}
                    onClick={() => repeat.mutate()}
                  >
                    {repeated ? "Task started" : "Run again"}
                  </Button>
                )}
                {canSchedule && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid={`job-daily-${job.id}`}
                    disabled={scheduled || schedule.isPending}
                    onClick={() => setDaily(!daily)}
                  >
                    {scheduled ? "Runs every day" : "Run every day"}
                  </Button>
                )}
              </div>
              {repeat.error && (
                <p role="alert" className="text-sm text-destructive">
                  {repeat.error.message}
                </p>
              )}
              {daily && (
                <form
                  className="flex flex-wrap items-end gap-3"
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (time && !schedule.isPending) schedule.mutate()
                  }}
                >
                  <label className="flex flex-col gap-2 text-sm">
                    Every day · {Intl.DateTimeFormat().resolvedOptions().timeZone}
                    <Input
                      data-testid={`job-daily-time-${job.id}`}
                      type="time"
                      required
                      value={time}
                      onChange={(e) => setTime(e.target.value)}
                    />
                  </label>
                  <Button
                    type="submit"
                    size="sm"
                    data-testid={`job-daily-save-${job.id}`}
                    loading={schedule.isPending}
                  >
                    Save schedule
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid={`job-daily-cancel-${job.id}`}
                    onClick={() => setDaily(false)}
                  >
                    Cancel
                  </Button>
                  {schedule.error && (
                    <p role="alert" className="w-full text-sm text-destructive">
                      {schedule.error.message}
                    </p>
                  )}
                </form>
              )}
            </div>
          )}
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
export function Transcript({
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
  const answer = [...q.data.messages]
    .reverse()
    .find((message) => message.author_kind === "agent" && !message.progress)
  const history = q.data.messages.filter((message) => message.id !== answer?.id)
  return (
    <div data-testid={`job-transcript-${id}`} className="flex max-w-2xl flex-col gap-4 pb-5 pl-8">
      {answer && (
        <div
          data-testid={`job-result-${id}`}
          className="rounded-xl border border-border bg-card p-4"
        >
          <p className="mb-2 text-xs font-medium text-muted-foreground">Result</p>
          <div
            className="text-sm leading-relaxed [&_a]:underline"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: mdToHtml escapes text and permits only HTTP or app-relative links.
            dangerouslySetInnerHTML={{ __html: mdToHtml(answer.body_md) }}
          />
        </div>
      )}
      <details data-testid={`job-details-${id}`} className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Usage and activity</summary>
        <div className="mt-4 flex flex-col gap-4">
          <TaskReceipt job={q.data} />
          {history.map((m) => (
            <div key={m.id} className="flex flex-col gap-1">
              <div className="flex items-baseline gap-2 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">
                  {m.author_kind === "agent"
                    ? agentName
                    : (first(names.get(m.author_id)) ?? "Someone")}
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
        </div>
      </details>
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

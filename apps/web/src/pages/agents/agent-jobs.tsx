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
import { useAuth } from "@/ctx"
import { accountsQuery, agentJobsQuery, agentQuery, jobQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useJobEvents } from "@/lib/use-job-events"
import { cn } from "@/lib/utils"
import { AgentArtifacts } from "./agent-artifacts"
import { AgentTaskList } from "./agent-task-list"
import {
  askedLine,
  failureOf,
  firstLine,
  JOB_ICON,
  machineName,
  machineOf,
  took,
  when,
} from "./format"
import { Meta, RowLine, Time } from "./rows"
import { AgentRowsSkeleton } from "./skeleton"
import { TaskConversation } from "./task-conversation"
import { TaskSchedule } from "./task-schedule"
import { taskStatus } from "./task-status"
import { TaskUsage } from "./task-usage"

const first = (name: string | undefined) => name?.trim().split(/\s+/)[0] || undefined

/** The one line that says why this agent's jobs will not start, or null when they will.
 *  `noAccount` is true only when the viewer can see that no model account would resolve. */
export function warningFor(
  agent: Pick<Agent, "paused" | "machine" | "seen_at" | "created_by">,
  names: Map<string, string>,
  noAccount = false,
  broken: string[] = [],
  meId?: string,
): string | null {
  if (agent.paused) return "This agent is paused. New tasks wait until you resume it in Settings."
  if (broken.length) return `${broken.join(", ")} needs to reconnect. Open Sources in Settings.`
  // Only a Derive machine needs a stored account; a runner on someone's own machine falls back
  // to the login on that machine.
  if (noAccount && agent.machine === "derive")
    return "Connect a model account in Settings to start cloud tasks."
  if (agent.machine === "derive") return null
  const machine = machineName(agent.created_by, names, meId)
  if (!agent.seen_at) return `${machine} has never connected. Tasks wait until it does.`
  if (machineOf(agent, names).on) return null
  return `${machine} has been off since ${when(agent.seen_at)}. Tasks wait until it is back.`
}

/** The machine's owner can fix a waiting task in one command; point them at it. */
const canStartRunner = (agent: Pick<Agent, "machine" | "seen_at" | "created_by">, meId: string) =>
  agent.machine === "owner" && agent.created_by === meId && !machineOf(agent, new Map()).on

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
  const [source, setSource] = useState("all")
  const [needsOnly, setNeedsOnly] = useState(false)
  const jobs = useInfiniteQuery({
    ...agentJobsQuery(agent.id, usage ? "all" : source, !usage && needsOnly),
    refetchInterval: 10_000,
  })
  useQuery({ ...agentQuery(agent.id), refetchInterval: 10_000 })
  const warning = warningFor(
    agent,
    names,
    useNoAccount(agent, meId),
    agent.can_manage ? brokenSources(agent) : [],
    meId,
  )
  const rows = jobs.data?.pages.flatMap((p) => p.jobs) ?? []

  const needs = rows.filter((job) => job.status === "needs_you")
  return (
    <div className="flex flex-col gap-6">
      {warning && (
        <p data-testid="agent-warning" role="status" className="text-sm text-warning">
          {warning}
          {!agent.paused && canStartRunner(agent, meId) && (
            <>
              {" "}
              <Link
                to="/settings/$section"
                params={{ section: "machines" }}
                data-testid="agent-start-runner"
                className="font-medium underline"
              >
                Start it from Settings.
              </Link>
            </>
          )}
        </p>
      )}
      {!usage && needs.length > 0 && (
        <Link
          to="/tasks/$id"
          params={{ id: needs[0]?.id ?? "" }}
          data-testid="agent-attention"
          className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm"
        >
          <span className="font-medium">
            {needs.length} {needs.length === 1 ? "task needs" : "tasks need"} your attention
          </span>
          <span className="ml-2 text-muted-foreground">
            {needs[0]?.needs?.question ?? "Open task to continue"} →
          </span>
        </Link>
      )}
      {!usage && <AgentArtifacts agent={agent} />}
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
      ) : (
        <div className="flex flex-col gap-3">
          <AgentTaskList
            jobs={rows}
            agent={agent}
            source={source}
            onSource={setSource}
            needsOnly={needsOnly}
            onNeedsOnly={setNeedsOnly}
          />
        </div>
      )}
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
    </div>
  )
}

/** The names of this agent's sources and secrets that are no longer active. The agent names
 *  what it is bound to itself, so no second request is needed. */
function brokenSources(agent: AgentDetail): string[] {
  const byId = new Map(agent.sources.map((s) => [s.id, s]))
  const broken: string[] = []
  for (const id of agent.connection_ids) {
    const s = byId.get(id)
    if (s && s.status !== "active") broken.push(s.name)
  }
  for (const [name, id] of Object.entries(agent.environment)) {
    if (byId.get(id)?.status !== "active") broken.push(name)
  }
  return broken
}

/** What a source is called in the product: the MCP server's host, or the integration's name. */
export const sourceName = (c: Connection): string =>
  c.kind === "mcp" && c.base_url
    ? c.base_url.replace(/^https?:\/\//, "")
    : c.kind === "secret"
      ? c.scopes_label?.trim() || "Stored secret"
      : c.toolkit

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
}: {
  job: Job
  canSteer: boolean
  /** Shown before the question where the list spans agents (the inbox). */
  title?: ReactNode
  agentName: string
  names: Map<string, string>
  /** Always under the question: a link to the page a review waits on. */
  below?: ReactNode
}) {
  const [open, setOpen] = useState(false)
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
      className="flex flex-col gap-3 border-b border-border py-3 last:border-b-0"
    >
      {/* Short by default: who is asking, then the question on one line. The rest (the
          whole question, the conversation, the answer) opens with a tap. */}
      <div className="flex items-start gap-3.5">
        <Icon
          name="job-needs-you"
          size={18}
          strokeWidth={1.75}
          className="mt-0.5 shrink-0 text-warning"
        />
        <div className="flex min-w-0 flex-1 flex-col">
          {title && <span className="truncate font-medium text-foreground">{title}</span>}
          <button
            type="button"
            data-testid={`job-row-${job.id}`}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="min-w-0 truncate text-left text-base text-foreground"
          >
            {/* Opened, the question reads in full in the conversation below. */}
            {gist}
          </button>
        </div>
        <Meta>
          <span className="contents max-sm:hidden">
            {job.needs?.question_id && (
              <Link
                to="/tasks/$id"
                params={{ id: job.id }}
                data-testid={`job-task-link-${job.id}`}
                className="font-medium text-foreground hover:underline"
              >
                Open task
              </Link>
            )}
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
          </span>
          <Time>{when(job.updated_at)}</Time>
          <span className="contents max-sm:hidden">
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
          </span>
        </Meta>
      </div>
      {/* On a phone the row keeps only its time; its links open with it. */}
      {open && (
        <div className="flex flex-wrap items-center gap-4 pl-8 text-sm text-muted-foreground sm:hidden">
          {job.needs?.question_id && (
            <Link
              to="/tasks/$id"
              params={{ id: job.id }}
              data-testid={`job-task-link-m-${job.id}`}
              className="font-medium text-foreground hover:underline"
            >
              Open task
            </Link>
          )}
          {asked && <span>{asked}</span>}
          {job.report_short_id && (
            <Link
              to="/artifacts/$ref"
              params={{ ref: job.report_short_id }}
              data-testid={`job-report-link-m-${job.id}`}
              className="font-medium text-foreground hover:underline"
            >
              Report
            </Link>
          )}
          {canSteer && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-testid={`job-dismiss-m-${job.id}`}
              loading={dismiss.isPending}
              onClick={() => dismiss.mutate()}
              className="text-muted-foreground"
            >
              Dismiss
            </Button>
          )}
        </div>
      )}
      {below}
      {open && <Transcript id={job.id} agentName={agentName} names={names} />}
      {open && canSteer && <AnswerBox job={job} />}
    </div>
  )
}
/** Whether the viewer can tell that no model account would resolve for this agent's jobs.
 *  Only its creator can: the fallback is the creator's own account, then a shared one, and
 *  nobody else sees the creator's accounts. */
export function useNoAccount(agent: AgentDetail, meId: string): boolean {
  const mine = agent.machine === "derive" && !agent.account_id && agent.created_by === meId
  const accounts = useQuery({ ...accountsQuery(), enabled: mine })
  if (!mine || !accounts.data) return false
  return !accounts.data.some(
    (a) => a.provider === (agent.provider === "codex" ? "codex" : "claude") && (a.mine || a.shared),
  )
}

export function detailOf(
  job: Job,
  agent: Agent,
  names: Map<string, string> = new Map(),
  meId?: string,
): string | undefined {
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
  if (job.status === "queued" && agent.paused) return "Resume this agent in Settings to start"
  if (job.status === "queued" && agent.machine === "owner" && !machineOf(agent, names).on) {
    const machine = machineName(agent.created_by, names, meId).replace(/^Your/, "your")
    return agent.seen_at
      ? `Waiting for ${machine}, off since ${when(agent.seen_at)}`
      : `Waiting for ${machine}, never connected`
  }
  if (job.status === "queued") return "Waiting for its turn"
  if (job.status === "running" && job.machine_waiting)
    return `Waiting to start: ${job.machine_waiting}`
  if (job.status === "running" && job.machine_phase === "creating")
    return "Building its own machine from the agent's image…"
  if (job.status === "running" && job.machine_phase === "provisioning")
    return "Setting up its machine. The first start takes a minute or two."
  if (job.status === "running" && job.machine_phase === "starting") return "Waking its machine…"
  if (job.status === "running" && ["ready", "launching"].includes(job.machine_phase ?? ""))
    return "Starting the task…"
  if (job.status === "running" && job.machine_phase === "stopping") return "Saving its files…"
  if (job.status === "succeeded" && job.machine_phase === "stopping")
    return "Your result is ready. Stopping compute and collecting its receipt."
  if (job.machine_phase === "parked")
    return job.task.session
      ? "Paused with its files kept. Attach to pick it up where it left off."
      : "Its machine is paused with the files kept, ready for a follow-up."
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
  const { me } = useAuth()
  const invalidate = [["jobs"]]
  const cancel = useApiMutation({ mutationFn: () => api.cancelJob(job.id), invalidate })
  const retry = useApiMutation({ mutationFn: () => api.retryJob(job.id), invalidate })
  const repeatKey = useRef(crypto.randomUUID())
  const [repeated, setRepeated] = useState(false)
  const repeat = useApiMutation({
    errorToast: false,
    mutationFn: () =>
      api.askAgent(agent.id, job.instruction, undefined, { dedupe_key: repeatKey.current }),
    invalidate,
    onSuccess: () => {
      setRepeated(true)
    },
  })
  const needs = job.status === "needs_you"
  const failed = job.status === "failed" || job.status === "lost"
  const detail = detailOf(job, agent, names, me?.id)
  const asker =
    job.kind === "scheduled" ? "Schedule" : job.asked_by ? first(names.get(job.asked_by)) : null

  return (
    <div
      data-testid={`job-${job.id}`}
      data-status={job.status}
      className="border-b border-border transition-colors motion-reduce:transition-none last:border-b-0"
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
            detail={detail && <span className="line-clamp-2 whitespace-normal">{detail}</span>}
          />
        </button>
        <Meta>
          <Link
            to="/tasks/$id"
            params={{ id: job.id }}
            data-testid={`job-open-${job.id}`}
            className="text-sm text-muted-foreground hover:text-foreground hover:underline"
          >
            Open task
          </Link>
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
                  <TaskSchedule
                    agentId={agent.id}
                    instruction={job.instruction}
                    triggers={triggers}
                  />
                )}
              </div>
              {repeat.error && (
                <p role="alert" className="text-sm text-destructive">
                  {repeat.error.message}
                </p>
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
    <form
      onSubmit={submit}
      className="mb-3 ml-8 flex flex-wrap items-center gap-2 border-l-2 border-warning/50 pl-3"
    >
      {options.map((o, i) => (
        <Button
          key={o}
          type="button"
          variant="outline"
          size="sm"
          data-testid={`job-option-${job.id}-${i}`}
          disabled={answer.isPending}
          onClick={() => answer.mutate({ option: o })}
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
        className="h-8 max-w-sm min-w-48 flex-1"
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
  return (
    <div data-testid={`job-transcript-${id}`} className="flex max-w-2xl flex-col gap-4 pb-5 pl-8">
      <TaskConversation job={q.data} agentName={agentName} names={names} />
    </div>
  )
}

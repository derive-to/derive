import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { useRef, useState } from "react"
import { ApiError, api } from "@/api"
import { LoadError } from "@/components/shared/load-error"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { StatusBadge } from "@/components/shared/status-badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { useAuth } from "@/ctx"
import { agentQuery, jobQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useDocumentTitle } from "@/lib/use-document-title"
import { useJobEvents } from "@/lib/use-job-events"
import { useTaskDraft } from "@/lib/use-task-draft"
import { taskStatus, useCanSteer } from "./agent-jobs"
import { firstLine } from "./format"
import { Segmented } from "./rows"
import { TaskConversation } from "./task-conversation"
import { TaskSchedule } from "./task-schedule"
import { useMemberNames } from "./use-member-names"

export function TaskPagePending() {
  return (
    <PageShell>
      <div
        role="status"
        aria-label="Opening your task"
        data-testid="task-loading"
        className="flex flex-col gap-6"
      >
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    </PageShell>
  )
}

export function TaskPage({ id }: { id: string }) {
  const { me } = useAuth()
  const navigate = useNavigate()
  useJobEvents()
  const job = useQuery({ ...jobQuery(id), refetchInterval: 5_000 })
  const agent = useQuery({ ...agentQuery(job.data?.agent_id ?? ""), enabled: !!job.data })
  const names = useMemberNames()
  const canSteer = useCanSteer(job.data, me?.id)
  const draft = useTaskDraft(id, me?.id)
  const [interrupt, setInterrupt] = useState(false)
  const { text } = draft
  const answering = draft.action ? draft.action === "answer" : job.data?.status === "needs_you"
  const composer = useRef<HTMLTextAreaElement>(null)
  useDocumentTitle(job.data ? firstLine(job.data.instruction).slice(0, 72) : "Task")
  const send = useApiMutation({
    errorToast: false,
    paywall: false,
    mutationFn: () => {
      const request = draft.submission(
        job.data?.status === "needs_you" ? "answer" : "follow_up",
        job.data?.needs?.question_id ?? null,
      )
      return request.action === "answer"
        ? api.answerJob(id, {
            text: request.text.trim(),
            question_id: request.questionId ?? undefined,
            dedupe_key: request.key,
          })
        : api.writeJob(id, request.text.trim(), request.key, interrupt)
    },
    invalidate: [["jobs"], ["agents"]],
    onSuccess: () => {
      draft.clear()
      composer.current?.focus()
    },
    onError: (e) => {
      if (e instanceof ApiError) draft.retry(e.status)
    },
  })
  const stopKey = useRef(crypto.randomUUID())
  const stop = useApiMutation({
    mutationFn: () => api.cancelJob(id, stopKey.current),
    invalidate: [["jobs"], ["agents"]],
  })
  const repeatKey = useRef(crypto.randomUUID())
  const retryKey = useRef(crypto.randomUUID())
  const retry = useApiMutation({
    mutationFn: () => api.retryJob(id, retryKey.current),
    invalidate: [["jobs"], ["agents"]],
    onError: (e) => {
      if (e instanceof ApiError && e.status < 500) retryKey.current = crypto.randomUUID()
    },
  })
  const repeat = useApiMutation({
    mutationFn: () =>
      api.askAgent(job.data?.agent_id ?? "", job.data?.instruction ?? "", undefined, {
        dedupe_key: repeatKey.current,
      }),
    invalidate: [["jobs"], ["agents"]],
    onSuccess: (next) => {
      void navigate({ to: "/tasks/$id", params: { id: next.id } })
    },
  })
  if (job.isError)
    return (
      <PageShell>
        <LoadError
          title="Couldn’t open this task."
          testId="task-page-retry"
          onRetry={() => void job.refetch()}
        />
      </PageShell>
    )
  if (!job.data || (!agent.data && !agent.isError)) return <TaskPagePending />
  const task = job.data
  const agentName = agent.data?.name ?? task.turns?.[0]?.execution.agent_name ?? "Deleted agent"
  const active =
    task.status === "queued" || task.status === "running" || task.status === "needs_you"
  const latest = task.turns?.at(-1)
  const ownsConversation = !latest || latest.actor_id === me?.id
  const continueAllowed =
    ownsConversation && (active || !latest || task.turns?.some((t) => t.resumable))
  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title={agentName}
        titleTestId="task-title"
        eyebrow={
          <Link
            to="/agents/$id"
            params={{ id: task.agent_id }}
            search={{}}
            data-testid="task-agent-back"
            className="hover:underline"
          >
            {agentName}
          </Link>
        }
        subtitle={`${task.kind === "scheduled" ? "Scheduled by" : "Started by"} ${names.get(task.asked_by ?? "") ?? (task.kind === "scheduled" ? "Schedule" : "Teammate")}`}
      />
      <div
        className="flex flex-wrap items-center justify-between gap-3"
        role="status"
        data-testid="task-status"
      >
        <StatusBadge
          tone={
            task.status === "succeeded"
              ? "ok"
              : task.status === "needs_you"
                ? "attention"
                : task.status === "failed" || task.status === "lost"
                  ? "error"
                  : active
                    ? "busy"
                    : "muted"
          }
        >
          {agent.data ? taskStatus(task, agent.data) : "Agent deleted"}
        </StatusBadge>
        {canSteer && active && (
          <Button
            variant="ghost"
            size="sm"
            data-testid="task-stop"
            loading={stop.isPending}
            onClick={() => stop.mutate()}
          >
            Stop
          </Button>
        )}
      </div>
      {task.task.session && task.asked_by === me?.id && active && <SessionAttach jobId={task.id} />}
      <TaskConversation job={task} agentName={agentName} names={names} />
      {task.needs && (
        <div className="rounded-xl border border-border bg-card p-4" data-testid="task-question">
          <p className="text-sm font-medium">{task.needs.question}</p>
          <p className="mt-2 text-sm text-muted-foreground">Your answer continues this task.</p>
          {task.needs.options?.map((option) => (
            <Button
              key={option}
              variant="outline"
              size="sm"
              data-testid={`task-option-${option}`}
              className="mt-3 mr-2"
              onClick={() => draft.change(option)}
            >
              {option}
            </Button>
          ))}
        </div>
      )}
      {canSteer && task.status !== "cancelled" && continueAllowed && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (text.trim() && !send.isPending) send.mutate()
          }}
          className="flex flex-col gap-3"
        >
          <Textarea
            ref={composer}
            aria-label={answering ? "Your answer" : "Add to this task"}
            data-testid="task-reply"
            placeholder={answering ? "Your answer…" : "What should we do next?"}
            value={text}
            maxLength={20_000}
            disabled={send.isPending}
            onChange={(event) => draft.change(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                if (text.trim() && !send.isPending) send.mutate()
              }
            }}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              data-testid="task-send"
              disabled={!text.trim()}
              loading={send.isPending}
            >
              {draft.action
                ? answering
                  ? "Retry answer"
                  : "Retry follow-up"
                : answering
                  ? "Send answer"
                  : "Send follow-up"}
            </Button>
            {draft.action ? (
              <p className="text-xs text-muted-foreground">
                This draft may already be sent. You can retry safely.
              </p>
            ) : (
              task.status === "running" &&
              !answering && (
                <Segmented
                  testId="task-send-when"
                  value={interrupt ? "now" : "after"}
                  onChange={(v) => setInterrupt(v === "now")}
                  options={[
                    { value: "after", label: "After this turn" },
                    { value: "now", label: "Interrupt" },
                  ]}
                />
              )
            )}
          </div>
          {send.error && (
            <div role="alert" className="text-sm text-destructive">
              <p>{send.error.message}</p>
              {/account|reconnect/i.test(send.error.message) && (
                <Link
                  to="/settings/$section"
                  params={{ section: "accounts" }}
                  data-testid="task-reconnect"
                  className="mt-2 inline-block underline"
                >
                  Open model accounts
                </Link>
              )}
            </div>
          )}
        </form>
      )}
      {canSteer && !active && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {(task.status === "failed" || task.status === "lost") && continueAllowed && (
              <Button
                data-testid="task-retry-turn"
                loading={retry.isPending}
                onClick={() => retry.mutate()}
              >
                Try this turn again
              </Button>
            )}
            <Button
              variant="outline"
              data-testid="task-run-again"
              loading={repeat.isPending}
              onClick={() => repeat.mutate()}
            >
              {continueAllowed && task.status !== "cancelled" ? "Run again" : "Start a fresh task"}
            </Button>
            {agent.data?.can_manage && (
              <TaskSchedule
                agentId={task.agent_id}
                instruction={task.instruction}
                triggers={agent.data.triggers}
              />
            )}
          </div>
          {repeat.error && (
            <p role="alert" className="text-sm text-destructive">
              {repeat.error.message}
            </p>
          )}
          {!continueAllowed && (
            <p className="text-sm text-muted-foreground">
              {ownsConversation
                ? "This turn did not save a usable conversation checkpoint. A fresh task gets a new conversation."
                : "This conversation uses another person’s accounts and files. Start a fresh task to work with yours."}
            </p>
          )}
        </div>
      )}
    </PageShell>
  )
}

/** An interactive session's way back in: the terminal command that attaches to it. */
function SessionAttach({ jobId }: { jobId: string }) {
  const command = `derive attach ${jobId.slice(-6)}`
  const [copied, setCopied] = useState(false)
  return (
    <div
      data-testid="task-session-attach"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3"
    >
      <div className="min-w-0">
        <p className="text-sm font-medium">Interactive session</p>
        <p className="text-sm text-muted-foreground">
          Open it in your terminal. It keeps running when you detach.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <code className="rounded-md bg-secondary px-2 py-1 font-mono text-sm">{command}</code>
        <Button
          variant="ghost"
          size="sm"
          data-testid="task-session-copy"
          onClick={() => void navigator.clipboard.writeText(command).then(() => setCopied(true))}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  )
}

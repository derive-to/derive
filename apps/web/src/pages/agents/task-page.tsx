import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { useRef } from "react"
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
  const { text } = draft
  const composer = useRef<HTMLTextAreaElement>(null)
  useDocumentTitle(job.data ? firstLine(job.data.instruction).slice(0, 72) : "Task")
  const send = useApiMutation({
    errorToast: false,
    paywall: false,
    mutationFn: () =>
      job.data?.status === "needs_you"
        ? api.answerJob(id, {
            text: text.trim(),
            question_id: job.data?.needs?.question_id,
            dedupe_key: draft.key,
          })
        : api.writeJob(id, text.trim(), draft.key),
    invalidate: [["jobs"], ["agents"]],
    onSuccess: () => {
      draft.clear()
      composer.current?.focus()
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status < 500) draft.retry()
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
            aria-label={task.status === "needs_you" ? "Your answer" : "Add to this task"}
            data-testid="task-reply"
            placeholder={task.status === "needs_you" ? "Your answer…" : "What should we do next?"}
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
              {task.status === "needs_you" ? "Send answer" : "Send follow-up"}
            </Button>
            {task.status === "running" && (
              <p className="text-xs text-muted-foreground">
                Your follow-up waits for this turn to finish.
              </p>
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

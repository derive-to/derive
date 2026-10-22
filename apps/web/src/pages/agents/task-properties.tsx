import { Link } from "@tanstack/react-router"
import type { AgentDetail, JobDetail } from "@/api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { cronLabel, when } from "./format"
import { TaskSchedule } from "./task-schedule"
import { taskStatus } from "./task-status"
import { TaskReceipt, TaskUsageSummary } from "./task-usage"

export function TaskUsageDialog({ job, label = "Usage" }: { job: JobDetail; label?: string }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="xs" data-testid="task-view-receipt">
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogTitle>Task usage</DialogTitle>
        <DialogDescription>
          All reported attempts, including failures and retries.
        </DialogDescription>
        <TaskUsageSummary job={job} />
        <TaskReceipt job={job} />
      </DialogContent>
    </Dialog>
  )
}

export function TaskProperties({
  job,
  agent,
  names,
}: {
  job: JobDetail
  agent?: AgentDetail
  names: Map<string, string>
}) {
  const turn = job.turns?.at(-1)
  const trigger = agent?.triggers.find((t) => t.id === job.trigger_id)
  const git = job.result.git
  return (
    <div className="flex flex-col gap-6" data-testid="task-properties">
      <section className="flex flex-col gap-4">
        <h2 className="text-xs font-medium">Properties</h2>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-4 text-xs [&_dt]:text-muted-foreground [&_dd]:break-words [&_dd]:text-right">
          <dt>Status</dt>
          <dd>{agent ? taskStatus(job, agent) : job.status}</dd>
          <dt>Agent</dt>
          <dd>{agent?.name ?? turn?.execution.agent_name ?? "Deleted agent"}</dd>
          <dt>Started by</dt>
          <dd>{job.asked_by ? (names.get(job.asked_by) ?? "Teammate") : "Schedule"}</dd>
          <dt>Source</dt>
          <dd>
            {trigger?.cron
              ? `${cronLabel(trigger.cron)} · ${trigger.tz ?? "UTC"}`
              : job.trigger_id
                ? trigger
                  ? "Event"
                  : "Removed trigger"
                : job.kind === "scheduled"
                  ? "Schedule"
                  : "Manual request"}
          </dd>
          <dt>Created</dt>
          <dd>{when(job.created_at)}</dd>
          <dt>Task</dt>
          <dd className="font-mono">{job.id.slice(-6)}</dd>
        </dl>
      </section>
      <div className="border-t border-border pt-5">
        <TaskUsageSummary job={job} />
        <div className="mt-2">
          <TaskUsageDialog job={job} label="View receipt →" />
        </div>
      </div>
      <details className="border-t border-border pt-5 text-xs" data-testid="task-facts">
        <summary className="cursor-pointer text-muted-foreground">Execution</summary>
        <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3 [&_dt]:text-muted-foreground [&_dd]:break-all [&_dd]:text-right">
          <dt>Model</dt>
          <dd data-testid="task-fact-harness">
            {turn?.execution.provider ?? agent?.provider} ·{" "}
            {turn?.execution.model ?? agent?.model ?? "Account default"}
          </dd>
          <dt>Machine</dt>
          <dd data-testid="task-fact-machine">
            {turn?.execution.sandbox || agent?.machine === "derive"
              ? "Derive cloud"
              : agent
                ? "Owner’s machine"
                : "Unknown"}
          </dd>
          {job.task.session && (
            <>
              <dt>Session</dt>
              <dd data-testid="task-fact-session">Interactive session</dd>
            </>
          )}
          {job.task.repo && (
            <>
              <dt>Repository</dt>
              <dd data-testid="task-fact-repo">{job.task.repo}</dd>
            </>
          )}
          {git?.commit && (
            <>
              <dt>Commit</dt>
              <dd data-testid="task-fact-git">
                <a
                  href={`https://github.com/${git.repo}/commit/${git.commit}`}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="task-commit-link"
                  className="hover:underline"
                >
                  {git.branch ?? "detached"} @ {git.commit.slice(0, 7)}
                </a>
              </dd>
            </>
          )}
        </dl>
      </details>
      {agent?.can_manage && (
        <div className="border-t border-border pt-4">
          <TaskSchedule
            agentId={agent.id}
            instruction={job.instruction}
            triggers={agent.triggers}
          />
          <Link
            to="/agents/$id"
            params={{ id: agent.id }}
            search={{ tab: "settings" }}
            data-testid="task-agent-settings"
            className="mt-3 block text-xs text-muted-foreground hover:text-foreground"
          >
            Agent settings →
          </Link>
        </div>
      )}
    </div>
  )
}

export function TaskPropertiesDialog(props: Parameters<typeof TaskProperties>[0]) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="xs" data-testid="task-open-properties">
          Details
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Task details</DialogTitle>
        <DialogDescription>Source, execution and usage for this task.</DialogDescription>
        <TaskProperties {...props} />
      </DialogContent>
    </Dialog>
  )
}

import { Link } from "@tanstack/react-router"
import type { JobDetail } from "@/api"
import { parseRef } from "../artifact/parse-ref"
import { eventLine } from "./format"
import { TaskEffects } from "./task-effects"
import { TaskMarkdown } from "./task-markdown"
import { TaskReceipt } from "./task-usage"

export function TaskConversation({
  job,
  agentName,
  names,
  canPin = false,
  showReceipt = true,
}: {
  job: JobDetail
  agentName: string
  names: Map<string, string>
  canPin?: boolean
  showReceipt?: boolean
}) {
  const effects = job.result.effects ?? []
  const events = job.events ?? []
  return (
    <div data-testid={`task-conversation-${job.id}`} className="flex flex-col gap-8">
      {job.result.failure && (job.status === "failed" || job.status === "lost") && (
        <div
          role="alert"
          data-testid="task-failure"
          className="rounded-xl border border-border bg-card p-4 text-sm"
        >
          <p>{job.result.failure.reason}</p>
          {/model account/i.test(job.result.failure.reason) && (
            <Link
              to="/settings/$section"
              params={{ section: "accounts" }}
              data-testid="task-failure-model-account"
              className="mt-2 inline-block underline"
            >
              Open model accounts
            </Link>
          )}
          {/sandbox|compute/i.test(job.result.failure.reason) && (
            <Link
              to="/settings/$section"
              params={{ section: "sources" }}
              data-testid="task-failure-sandbox"
              className="mt-2 inline-block underline"
            >
              Open sources
            </Link>
          )}
        </div>
      )}
      {job.turns?.length
        ? job.turns.map((turn) => (
            <section
              key={turn.id}
              data-testid={`task-turn-${turn.id}`}
              className="flex flex-col gap-7"
            >
              <div className="rounded-lg bg-secondary/50 px-4 py-3">
                <p className="text-xs font-medium text-muted-foreground">
                  {turn.actor_id ? (names.get(turn.actor_id) ?? "Teammate") : "Schedule"}
                </p>
                <div className="mt-2">
                  <TaskMarkdown text={turn.body_md} />
                </div>
              </div>
              {turn.body_result_md && (
                <div className="min-w-0">
                  <p className="mb-3 text-xs font-medium text-muted-foreground">{agentName}</p>
                  <TaskMarkdown text={turn.body_result_md} />
                  <TaskEffects
                    effects={turn.effects ?? []}
                    id={turn.id}
                    agentId={job.agent_id}
                    canPin={canPin}
                  />
                </div>
              )}
              {turn.status === "queued" && (
                <p className="text-sm text-muted-foreground">Waiting for its turn.</p>
              )}
              <details
                className="text-xs text-muted-foreground"
                data-testid={`task-turn-details-${turn.id}`}
              >
                <summary className="cursor-pointer">Run details</summary>
                <p className="mt-2">
                  {turn.execution.provider} · {turn.execution.model ?? "Account default"}
                  {turn.execution.skill && ` · Skill v${turn.execution.skill.version}`}
                  {turn.status === "succeeded" &&
                    ` · ${turn.resumable ? "Conversation saved" : "Continuation unavailable"}`}
                </p>
              </details>
            </section>
          ))
        : job.messages
            .filter((m) => !m.progress)
            .map((message) => (
              <div
                key={message.id}
                className={
                  message.author_kind === "agent"
                    ? "min-w-0"
                    : "rounded-lg bg-secondary/50 px-4 py-3"
                }
              >
                <p className="text-xs font-medium text-muted-foreground">
                  {message.author_kind === "agent"
                    ? agentName
                    : (names.get(message.author_id) ?? "Teammate")}
                </p>
                <div className="mt-2">
                  <TaskMarkdown text={message.body_md} />
                </div>
              </div>
            ))}
      {(showReceipt || events.length > 0 || job.messages.some((m) => m.progress)) && (
        <details className="text-sm" data-testid={`task-usage-${job.id}`}>
          <summary className="cursor-pointer text-muted-foreground">
            {showReceipt ? "Usage and activity" : "Activity"} · {events.length}
          </summary>
          {showReceipt && (
            <div className="mt-4">
              <TaskReceipt job={job} />
            </div>
          )}
          {events.map((event) => (
            <p
              key={`${event.turn_id}:${event.seq}`}
              className="mt-2 break-all font-mono text-xs text-muted-foreground"
            >
              {eventLine(event)}
            </p>
          ))}
          {job.messages
            .filter((m) => m.progress)
            .map((m) => (
              <p key={m.id} className="mt-2 text-sm text-muted-foreground">
                {m.body_md}
              </p>
            ))}
        </details>
      )}
      <TaskEffects
        effects={effects.filter(
          (e) =>
            !job.turns?.some((t) =>
              t.effects?.some(
                (other) =>
                  other.kind === e.kind &&
                  other.ref === e.ref &&
                  other.version === e.version &&
                  other.url === e.url &&
                  other.label === e.label,
              ),
            ),
        )}
        id={job.id}
        agentId={job.agent_id}
        canPin={canPin}
      />
      {job.report_short_id &&
        !effects
          .concat(job.turns?.flatMap((t) => t.effects ?? []) ?? [])
          .some(
            (e) => e.kind === "page" && e.ref && parseRef(e.ref).shortId === job.report_short_id,
          ) && (
          <Link
            to="/artifacts/$ref"
            params={{ ref: job.report_short_id }}
            data-testid={`job-report-${job.id}`}
            className="text-sm text-primary hover:underline"
          >
            Open report · latest version →
          </Link>
        )}
    </div>
  )
}

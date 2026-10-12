import { Link } from "@tanstack/react-router"
import type { JobDetail } from "@/api"
import { mdToHtml } from "../artifact/lib/markdown"
import { TaskReceipt } from "./task-usage"

export function TaskConversation({
  job,
  agentName,
  names,
}: {
  job: JobDetail
  agentName: string
  names: Map<string, string>
}) {
  const labels: Record<string, string> = {
    command_execution: "Ran a command",
    file_change: "Changed a file",
    mcp_tool_call: "Used a connected tool",
    web_search: "Searched the web",
    plan_update: "Updated its plan",
    tool_use: "Used a tool",
  }
  const effects = job.result.effects ?? []
  const id = job.id
  return (
    <div data-testid={`task-conversation-${job.id}`} className="flex flex-col gap-6">
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
              params={{ section: "connections" }}
              data-testid="task-failure-sandbox"
              className="mt-2 inline-block underline"
            >
              Open connections
            </Link>
          )}
        </div>
      )}
      {job.turns?.length
        ? job.turns.map((turn) => (
            <section
              key={turn.id}
              data-testid={`task-turn-${turn.id}`}
              className="flex flex-col gap-4"
            >
              <div className="border-l-2 border-border pl-4">
                <p className="text-xs font-medium text-muted-foreground">
                  {turn.actor_id ? (names.get(turn.actor_id) ?? "Teammate") : "Schedule"} · Turn{" "}
                  {turn.ordinal}
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{turn.body_md}</p>
              </div>
              {turn.body_result_md && (
                <div className="rounded-xl border border-border bg-card p-4">
                  <p className="mb-2 text-xs font-medium text-muted-foreground">{agentName}</p>
                  <div
                    className="text-sm leading-relaxed [&_a]:underline"
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: mdToHtml escapes text and validates links.
                    dangerouslySetInnerHTML={{
                      __html: mdToHtml(
                        turn.body_result_md.replace(
                          /\[([^\]]+)\]\((\/(?:home|tmp|Users)\/[^)]+)\)/g,
                          "$1",
                        ),
                      ),
                    }}
                  />
                </div>
              )}
              {turn.status === "queued" && (
                <p className="text-sm text-muted-foreground">Queued for its turn.</p>
              )}
              <details
                className="text-xs text-muted-foreground"
                data-testid={`task-turn-details-${turn.id}`}
              >
                <summary className="cursor-pointer">Turn details</summary>
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
              <div key={message.id} className="border-l-2 border-border pl-4">
                <p className="text-xs font-medium text-muted-foreground">
                  {message.author_kind === "agent"
                    ? agentName
                    : (names.get(message.author_id) ?? "Teammate")}
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">
                  {message.body_md}
                </p>
              </div>
            ))}
      <details className="text-sm" data-testid={`task-usage-${job.id}`}>
        <summary className="cursor-pointer text-muted-foreground">Usage and activity</summary>
        <div className="mt-4">
          <TaskReceipt job={job} />
        </div>
        {(job.events ?? []).map((event) => (
          <p key={`${event.turn_id}:${event.seq}`} className="mt-2 text-xs text-muted-foreground">
            {labels[event.kind] ?? "Worked on this task"}
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
      {(effects.length > 0 || job.report_short_id) && (
        <div className="flex flex-wrap gap-2">
          {job.report_short_id && (
            <Link
              to="/artifacts/$ref"
              params={{ ref: job.report_short_id }}
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

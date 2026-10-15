import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { type Agent, ApiError, api } from "@/api"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useAuth } from "@/ctx"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useTaskDraft } from "@/lib/use-task-draft"

/** The ask box on an agent's page: it names the agent, so there is no picker. */
export function TaskComposer({ agent }: { agent: Agent }) {
  const navigate = useNavigate()
  const { me } = useAuth()
  const draft = useTaskDraft(agent.id, me?.id)
  const [repo, setRepo] = useState("")
  const { text } = draft
  const runtime = useQuery({
    queryKey: ["agents", "runtime"],
    queryFn: api.agentRuntime,
    enabled: agent.machine === "derive",
  })
  const ask = useApiMutation({
    errorToast: false,
    mutationFn: () =>
      api.askAgent(agent.id, text.trim(), undefined, {
        dedupe_key: `${draft.key}:${agent.id}`,
        ...(agent.machine === "derive" && repo.trim() ? { repo: repo.trim() } : {}),
      }),
    invalidate: [["jobs"], ["agents"]],
    onSuccess: (job) => {
      draft.clear()
      void navigate({ to: "/tasks/$id", params: { id: job.id } })
    },
    onError: (error) => {
      if (error instanceof ApiError) draft.retry(error.status)
    },
  })
  const submit = () => {
    if (!text.trim() || ask.isPending) return
    ask.mutate()
  }
  return (
    <form
      data-testid="task-composer"
      className="rounded-xl border border-input bg-card p-4 shadow-sm focus-within:ring-2 focus-within:ring-ring/40"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <Textarea
        aria-label={`Ask ${agent.name}`}
        data-testid="agent-ask-input"
        placeholder={`Ask ${agent.name} to…`}
        value={text}
        maxLength={20_000}
        disabled={ask.isPending}
        onChange={(event) => {
          draft.change(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            submit()
          }
        }}
        className="min-h-24 resize-y border-0 bg-transparent p-0 text-base shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {agent.paused && <span>Paused · this task will wait</span>}
          {agent.machine === "derive" && (
            <Input
              aria-label="Repository"
              data-testid="task-composer-repo"
              placeholder={agent.repository ?? "owner/repo (optional)"}
              value={repo}
              disabled={ask.isPending}
              onChange={(event) => setRepo(event.target.value)}
              className="h-8 w-52 font-mono text-sm"
            />
          )}
        </div>
        <Button
          type="submit"
          size="sm"
          data-testid="agent-ask-send"
          disabled={!text.trim()}
          loading={ask.isPending}
        >
          Ask
        </Button>
      </div>
      <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
        <span>Enter to start · Shift+Enter for a new line</span>
        {agent.machine === "derive" && runtime.data?.enabled && (
          <span>Runs in the cloud · {runtime.data.provider === "boat" ? "boat.dev" : "Ortam"}</span>
        )}
        {agent.machine === "derive" && runtime.data && !runtime.data.enabled && (
          <Link
            to="/settings/$section"
            params={{ section: "sources" }}
            data-testid="task-connect-sandbox"
            className="text-warning underline"
          >
            Connect your sandbox to run
          </Link>
        )}
      </div>
      {agent.machine === "derive" && runtime.isError && (
        <StatusPanel
          tone="danger"
          layout="inline"
          title="We couldn’t check your sandbox"
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="task-runtime-retry"
              onClick={() => void runtime.refetch()}
            >
              Try again
            </Button>
          }
        />
      )}
      {ask.error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {ask.error.message}{" "}
          {ask.error instanceof ApiError && ask.error.status === 409 && (
            <>
              <Link
                to="/settings/$section"
                params={{ section: "accounts" }}
                data-testid="task-setup-accounts"
                className="underline"
              >
                Model accounts
              </Link>
              {" · "}
              <Link
                to="/settings/$section"
                params={{ section: "sources" }}
                data-testid="task-setup-connections"
                className="underline"
              >
                Connections
              </Link>
            </>
          )}
        </p>
      )}
    </form>
  )
}

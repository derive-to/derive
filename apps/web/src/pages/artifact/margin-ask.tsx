import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { type Agent, api } from "@/api"
import { LoadError } from "@/components/shared/load-error"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useAuth } from "@/ctx"
import { agentsQuery, jobQuery, workspaceQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { cn } from "@/lib/utils"
import { AnswerBox, useCanSteer } from "@/pages/agents/agent-jobs"
import { OPEN_STATUSES, rosterOf } from "@/pages/agents/format"

/** Mirrors the server's canAskAgent: anyone in the workspace, or for an invited-only agent,
 *  its creator and workspace owners. The server still decides. */
const canAsk = (a: Agent, meId: string, isOwner: boolean) =>
  !a.paused && (a.ask_policy === "workspace" || a.created_by === meId || isOwner)

// The margin Ask: at the top of a page's activity stream, pick one of the workspace's agents
// and ask it about this page. The ask is a job whose subject is the page; the box then follows
// that job until it settles, showing progress and the reply as they arrive.
export function MarginAsk({ shortId }: { shortId: string }) {
  const { me } = useAuth()
  const agents = useQuery(agentsQuery())
  const workspace = useQuery(workspaceQuery())
  const isOwner = workspace.data?.role === "owner"
  const askable = rosterOf(agents.data ?? []).filter((a) => me && canAsk(a, me.id, isOwner))
  const [picked, setPicked] = useState<string | null>(null)
  const [text, setText] = useState("")
  const [jobId, setJobId] = useState<string | null>(null)
  const agent = askable.find((a) => a.id === picked) ?? askable[0]
  const ask = useApiMutation({
    mutationFn: (a: Agent) => api.askAgent(a.id, text.trim(), { kind: "artifact", id: shortId }),
    invalidate: [["jobs"]],
    onSuccess: (job) => {
      setJobId(job.id)
      setText("")
    },
  })

  if (agents.isError)
    return (
      <LoadError
        layout="inline"
        title="Couldn’t load agents to ask."
        testId="margin-ask-retry"
        onRetry={() => void agents.refetch()}
        className="mx-1 mb-2"
      />
    )
  if (!agent) return null

  return (
    <div data-testid="margin-ask" className="mx-1 mb-3 flex flex-col gap-2 rounded-lg border p-2.5">
      {jobId ? (
        <AskFollow id={jobId} agentName={agent.name} onDone={() => setJobId(null)} />
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (text.trim()) ask.mutate(agent)
          }}
        >
          {askable.length > 1 && (
            <Select value={agent.id} onValueChange={setPicked}>
              <SelectTrigger
                size="sm"
                data-testid="margin-ask-agent"
                aria-label="Agent to ask"
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {askable.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) ask.mutate(agent)
            }}
            placeholder={`Ask ${agent.name} about this page`}
            aria-label={`Ask ${agent.name}`}
            data-testid="margin-ask-input"
            className="min-h-14"
          />
          {text.trim() && (
            <Button
              type="submit"
              size="xs"
              data-testid="margin-ask-send"
              loading={ask.isPending}
              className="self-end"
            >
              Ask {agent.name}
            </Button>
          )}
        </form>
      )}
    </div>
  )
}

const WORD: Record<string, string> = {
  queued: "Waiting for its machine",
  running: "Working on it",
  needs_you: "Needs your answer",
  succeeded: "Done",
  failed: "Failed",
  lost: "Its machine stopped answering",
  cancelled: "Cancelled",
}

/** One asked job, polled every few seconds until it settles. */
function AskFollow({
  id,
  agentName,
  onDone,
}: {
  id: string
  agentName: string
  onDone: () => void
}) {
  const q = useQuery({
    ...jobQuery(id),
    // Quick while it is working; slow while it waits on a machine or on a person.
    refetchInterval: (query) => {
      const status = query.state.data?.status
      if (!status || status === "running") return 3000
      if (status === "queued" || status === "needs_you") return 20_000
      return false
    },
  })
  const job = q.data
  const { me } = useAuth()
  const agents = useQuery(agentsQuery())
  const canSteer = useCanSteer(job, me?.id)
  // The job's own agent, which is the one asked even if the picker has moved on since.
  const name = agents.data?.find((a) => a.id === job?.agent_id)?.name ?? agentName
  if (q.isError)
    return (
      <LoadError
        layout="inline"
        title="Couldn’t follow that job."
        testId="margin-ask-follow-retry"
        onRetry={() => void q.refetch()}
      />
    )
  const replies = (job?.messages ?? []).filter((m) => m.author_kind === "agent")
  const open = !job || OPEN_STATUSES.includes(job.status)
  return (
    <div data-testid="margin-ask-job" data-status={job?.status} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          <span className="font-medium text-foreground">{name}</span> ·{" "}
          {job ? WORD[job.status] : "Asking"}
        </span>
        {job?.report_short_id && (
          <Link
            to="/artifacts/$ref"
            params={{ ref: job.report_short_id }}
            data-testid="margin-ask-report"
            className="font-medium text-foreground hover:underline"
          >
            Report
          </Link>
        )}
      </div>
      {replies.map((m) => (
        <p
          key={m.id}
          className={cn(
            "text-sm whitespace-pre-wrap",
            m.progress ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {m.body_md}
        </p>
      ))}
      {job?.status === "needs_you" && canSteer && <AnswerBox job={job} />}
      {!open && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-testid="margin-ask-again"
          onClick={onDone}
          className="self-start text-muted-foreground"
        >
          Ask something else
        </Button>
      )}
    </div>
  )
}

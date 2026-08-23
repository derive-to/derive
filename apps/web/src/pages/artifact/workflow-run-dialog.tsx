import { useQuery } from "@tanstack/react-query"
import { ApiError, api, type DirUser } from "@/api"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { toast } from "@/components/ui/sonner"
import { copyText } from "@/lib/clipboard"
import { useApiMutation } from "@/lib/use-api-mutation"
import { AgentMenu, ALREADY_QUEUED, queuedFor } from "./ask-agent"
import type { AgentTarget } from "./types"

export function WorkflowRunDialog({
  shortId,
  diagramId,
  agents,
  open,
  onOpenChange,
}: {
  shortId: string
  diagramId: string
  agents: DirUser[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { data, isError, refetch } = useQuery({
    queryKey: ["workflow-run-prompt", shortId, diagramId] as const,
    queryFn: () => api.workflowRunPrompt(shortId, diagramId),
    enabled: open,
  })
  const run = useApiMutation<{ requestId: string }, AgentTarget>({
    mutationFn: (agent) => api.runWorkflow(shortId, { agentId: agent.id, diagramId }),
    success: (_result, agent) => queuedFor("Workflow", agent.name),
    errorToast: false,
    onError: (error) => {
      if (error instanceof ApiError && error.code === "alreadyQueued") toast(ALREADY_QUEUED)
      else if (error instanceof ApiError && error.code === "needsChanges")
        toast.error("This workflow needs changes before it can run.")
      else toast.error("Couldn’t hand off this workflow. Try again.")
    },
    onSuccess: () => onOpenChange(false),
  })
  const copy = () => {
    if (!data) return
    void copyText(data.prompt, { success: "Prompt copied. Paste it into your agent." })
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Run with your agent</DialogTitle>
          <DialogDescription>
            Your approved Codex, Claude, or other agent runs the context sessions. Derive keeps the
            graph, artifacts, review, and receipts—it is not the runtime.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border border-success/25 bg-success/5 px-3 py-2 text-xs text-success">
          Preview passed. Nothing starts until you hand this to an agent.
        </div>
        <div className="rounded-md border border-border">
          <Eyebrow
            as="div"
            className="flex items-center justify-between border-b border-border-soft py-1 pr-1 pl-3"
          >
            Prompt for any agent
            <Button variant="ghost" size="sm" data-testid="workflow-run-copy" onClick={copy}>
              Copy
            </Button>
          </Eyebrow>
          {isError ? (
            <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
              Couldn’t compose the handoff.
              <Button
                variant="ghost"
                size="sm"
                data-testid="workflow-run-retry"
                onClick={() => refetch()}
              >
                Retry
              </Button>
            </div>
          ) : (
            <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs text-muted-foreground">
              {data?.prompt ?? "…"}
            </pre>
          )}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          A registered agent receives this in its pull inbox and starts the next time it checks in.
          Copy works with any local harness.
        </p>
        <DialogFooter>
          <AgentMenu
            agents={agents}
            menuLabel="Run with which agent?"
            testidPrefix="workflow-run-agent"
            onPick={(agent) => run.mutate(agent)}
            trigger={({ sole, onClick }) => (
              <Button
                data-testid="workflow-run-send"
                disabled={run.isPending || !data}
                onClick={onClick}
              >
                {sole ? `Run with ${sole.name}` : "Run with my agent"}
              </Button>
            )}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

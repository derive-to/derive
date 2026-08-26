import { useQuery, useQueryClient } from "@tanstack/react-query"
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
import { cn } from "@/lib/utils"
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
  const queryClient = useQueryClient()
  const { data, error, isError, refetch } = useQuery({
    queryKey: ["workflow-run-prompt", shortId, diagramId] as const,
    queryFn: () => api.workflowRunPrompt(shortId, diagramId),
    enabled: open,
  })
  const previewChanged = error instanceof ApiError && error.code === "needsChanges"
  const handoffReady = !!data && !isError
  const run = useApiMutation<{ runId: string; prompt: string; requestId?: string }, AgentTarget>({
    mutationFn: (agent) => api.runWorkflow(shortId, { agentId: agent.id, diagramId }),
    success: (_result, agent) => {
      void queryClient.invalidateQueries({ queryKey: ["workflow-runs", shortId, diagramId] })
      queuedFor("Workflow", agent.name)
    },
    errorToast: false,
    onError: (error) => {
      if (error instanceof ApiError && error.code === "alreadyQueued") toast(ALREADY_QUEUED)
      else if (error instanceof ApiError && error.code === "needsChanges")
        toast.error("This workflow needs changes before it can run.")
      else toast.error("Couldn’t hand off this workflow. Try again.")
    },
    onSuccess: () => onOpenChange(false),
  })
  const copyRun = useApiMutation<{ runId: string; prompt: string }, void>({
    mutationFn: () => api.runWorkflow(shortId, { diagramId, delivery: "copy" }),
    success: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["workflow-runs", shortId, diagramId] })
      void copyText(result.prompt, { success: "Prompt copied. Paste it into your agent." })
    },
    errorToast: false,
    onError: () => toast.error("Couldn’t start this workflow. Try again."),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Run with your agent</DialogTitle>
          <DialogDescription>
            Your Codex, Claude, or other agent runs the context sessions. Derive keeps the graph,
            artifacts, review, and receipts—it is not the runtime.
          </DialogDescription>
        </DialogHeader>
        <div
          className={cn(
            "rounded-lg border px-3 py-2 text-xs",
            handoffReady
              ? "border-success/25 bg-success/5 text-success"
              : isError
                ? "border-destructive/25 bg-destructive/5 text-destructive"
                : "border-border bg-muted/30 text-muted-foreground",
          )}
        >
          {handoffReady
            ? "Preview passed. Nothing starts until you hand this to an agent."
            : previewChanged
              ? "Preview is out of date. Return to the workflow and review it again."
              : isError
                ? "Handoff unavailable."
                : "Checking the latest Preview…"}
        </div>
        <div className="rounded-md border border-border">
          <Eyebrow
            as="div"
            className="flex items-center justify-between border-b border-border-soft py-1 pr-1 pl-3"
          >
            Run preview
            <Button
              variant="ghost"
              size="sm"
              data-testid="workflow-run-copy"
              disabled={!data || copyRun.isPending}
              onClick={() => copyRun.mutate()}
            >
              {copyRun.isPending ? "Starting…" : "Start & copy"}
            </Button>
          </Eyebrow>
          {isError ? (
            <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
              {previewChanged
                ? "The workflow changed and needs a fresh Preview."
                : "Couldn’t compose the handoff."}
              <Button
                variant="ghost"
                size="sm"
                data-testid="workflow-run-retry"
                onClick={() => (previewChanged ? onOpenChange(false) : refetch())}
              >
                {previewChanged ? "Close" : "Retry"}
              </Button>
            </div>
          ) : (
            <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs text-muted-foreground">
              {data?.prompt ?? "…"}
            </pre>
          )}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Start & copy creates a fresh run for a Derive-connected local harness. A registered agent
          receives the same instruction in its pull inbox and starts when it checks in.
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

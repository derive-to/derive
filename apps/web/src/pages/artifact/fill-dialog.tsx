import { useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { ApiError, api, type DirUser } from "@/api"
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
import { Textarea } from "@/components/ui/textarea"
import { useApiMutation } from "@/lib/use-api-mutation"
import { AgentMenu, ALREADY_QUEUED, queuedFor } from "./ask-agent"
import type { AgentTarget } from "./types"

// "Fill with your work" — the transform sheet on a derived copy. One optional line
// of intent, and the server-composed prompt (fillInstruction is the single source;
// the ask below delivers the identical text). The client never assembles prompt
// text — it only chooses where the instruction goes: the clipboard, or an agent.
export function FillDialog({
  shortId,
  agents,
  open,
  onOpenChange,
}: {
  shortId: string
  agents: DirUser[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [note, setNote] = useState("")
  // The preview re-composes as the note settles, not per keystroke. Copy reads the
  // settled preview synchronously so the clipboard write stays inside the click
  // gesture (Safari drops writes that follow an await).
  const [settled, setSettled] = useState("")
  useEffect(() => {
    const t = setTimeout(() => setSettled(note), 400)
    return () => clearTimeout(t)
  }, [note])
  const { data, isError, refetch } = useQuery({
    queryKey: ["fill-prompt", shortId, settled] as const,
    queryFn: () => api.fillPrompt(shortId, settled || undefined),
    enabled: open,
    placeholderData: (prev) => prev,
  })
  const ask = useApiMutation<{ requestId: string }, AgentTarget>({
    mutationFn: (a) => api.fillArtifact(shortId, { agentId: a.id, note: note || undefined }),
    success: (_r, a) => queuedFor("Fill", a.name),
    errorToast: false,
    onError: (err) => {
      if (err instanceof ApiError && err.code === "alreadyQueued") toast(ALREADY_QUEUED)
      else toast.error("Fill request failed — try again.")
    },
    onSuccess: () => onOpenChange(false),
  })
  const copy = () => {
    if (!data) return
    navigator.clipboard
      .writeText(data.prompt)
      .then(() => toast("Prompt copied — paste it into your agent."))
      .catch(() => toast.error("Couldn't reach the clipboard."))
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Fill with your work</DialogTitle>
          <DialogDescription>
            Your agent replaces the example content with your real work — and reshapes the document
            to fit it.
          </DialogDescription>
        </DialogHeader>
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-2xs uppercase tracking-wide text-muted-foreground">
            What should this be about?{" "}
            <span className="normal-case tracking-normal">(optional — your agent will ask)</span>
          </span>
          <Textarea
            data-testid="fill-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            rows={2}
            placeholder="e.g. Week 32 for the payments team — skip the hiring section"
          />
        </label>
        <div className="rounded-md border border-border">
          <div className="flex items-center justify-between border-b border-border-soft py-1 pr-1 pl-3 font-mono text-2xs uppercase tracking-wide text-muted-foreground">
            Prompt for your agent
            <Button variant="ghost" size="sm" data-testid="fill-copy" onClick={copy}>
              Copy
            </Button>
          </div>
          {isError ? (
            <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
              Couldn't compose the prompt.
              <Button variant="ghost" size="sm" data-testid="fill-retry" onClick={() => refetch()}>
                Retry
              </Button>
            </div>
          ) : (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-xs text-muted-foreground">
              {data?.prompt ?? "…"}
            </pre>
          )}
        </div>
        <DialogFooter>
          <AgentMenu
            agents={agents}
            menuLabel="Ask which agent?"
            testidPrefix="fill-ask"
            onPick={(a) => ask.mutate(a)}
            trigger={({ sole, onClick }) => (
              <Button data-testid="fill-ask" disabled={ask.isPending} onClick={onClick}>
                {sole ? `Ask ${sole.name}` : "Ask your agent"}
              </Button>
            )}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

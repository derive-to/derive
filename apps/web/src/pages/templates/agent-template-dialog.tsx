import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useId, useRef, useState } from "react"
import { api } from "@/api"
import { Icon } from "@/components/icons"
import { ConnectAgentDialogContent } from "@/components/shared/connect-agent"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { useCopy } from "@/lib/clipboard"
import { workspaceQuery } from "@/lib/queries"
import { type AgentTemplateTarget, localAgentHandoff, nativeTemplateRequest } from "./agent-handoff"

export type { AgentTemplateTarget } from "./agent-handoff"

const exampleBrief = (target: AgentTemplateTarget) => {
  const namedInputs = target.inputs?.slice(0, 3).map((input) => input.name.toLowerCase()) ?? []
  if (namedInputs.length)
    return `What are you making? Include ${namedInputs.join(", ")}, plus anything your agent should know.`
  if (target.kind === "context")
    return "What should this context help your team’s agents know or do?"
  if (target.category === "Deck")
    return "Describe the story, audience, and outcome you want from this deck."
  return "Describe what you want to make, who it is for, and what a strong result should accomplish."
}

/**
 * The product handoff from a reusable shape to an agent job. Local agents get a
 * portable prompt with the exact URI; native beta carries that URI separately so
 * the chat stays conversational. Neither path exposes artifact source.
 */
export function AgentTemplateDialog({
  target,
  onOpenChange,
}: {
  target: AgentTemplateTarget | null
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const [brief, setBrief] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const [showHandoff, setShowHandoff] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  const { copied, copy } = useCopy(4000)
  const mounted = useRef(true)
  const descriptionId = useId()
  const workspaceState = useQuery(workspaceQuery())
  const workspace = workspaceState.data

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (target) {
      setBrief("")
      setError("")
      setShowHandoff(false)
      setConnectOpen(false)
    }
  }, [target])

  if (!target) return null
  const isContext = target.kind === "context"

  const handoff = localAgentHandoff(target, brief)

  const copyForLocalAgent = async () => {
    if (!brief.trim() || submitting) return
    setError("")
    const ok = await copy(handoff, {
      success: "Copied — paste it into Claude Code or Codex",
      error: null,
    })
    if (!ok) {
      setShowHandoff(true)
      setError("Clipboard access was blocked. Select the handoff below and copy it manually.")
    }
  }

  const buildInDerive = async () => {
    if (!brief.trim() || !workspace || submitting) return
    setSubmitting(true)
    setError("")
    try {
      const created = await api.createChatSession({
        workspace: workspace.id,
        body_md: nativeTemplateRequest(target, brief),
        ...(isContext ? { purpose: "context_builder" as const } : {}),
        template_start: { uri: target.uri, title: target.title, kind: target.kind },
      })
      if (!mounted.current) return
      await navigate({
        to: "/chat",
        search: { session: created.session.id, model: undefined, ask: undefined },
      })
    } catch (cause) {
      if (!mounted.current) return
      setError(
        cause instanceof Error
          ? cause.message
          : "Derive couldn’t start this draft. Please try again.",
      )
    } finally {
      if (mounted.current) setSubmitting(false)
    }
  }

  return (
    <>
      <Dialog open={!connectOpen} onOpenChange={(open) => !submitting && onOpenChange(open)}>
        <DialogContent
          className="gap-4 sm:max-w-xl"
          aria-describedby={descriptionId}
          aria-busy={submitting}
          showCloseButton={!submitting}
          onEscapeKeyDown={(event) => submitting && event.preventDefault()}
          onPointerDownOutside={(event) => submitting && event.preventDefault()}
        >
          <DialogHeader className="pr-7">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <Badge variant="outline" shape="pill">
                <Icon name="copy" size={12} /> Ready for your agent
              </Badge>
              <span className="font-mono text-2xs uppercase tracking-wider text-muted-foreground">
                {isContext ? "Context" : target.category}
              </span>
            </div>
            <DialogTitle className="font-serif text-2xl tracking-tight [overflow-wrap:anywhere]">
              Make {target.title} yours
            </DialogTitle>
            <DialogDescription id={descriptionId} className="max-w-lg">
              {isContext
                ? "Describe the setup, then copy a complete handoff into Claude Code or Codex. It reads this exact reference and adapts the Context—not a manifest form."
                : "Describe the outcome, then copy a complete handoff into Claude Code or Codex. It reads this exact reference and returns a published draft—not source or a blank form."}
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-xl border bg-secondary/45 p-3">
            <div className="flex items-start gap-3">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-background">
                <Icon name="templates" size={15} />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{target.title}</p>
                <p className="mt-0.5 line-clamp-2 text-xs text-pretty text-muted-foreground">
                  {target.description}
                </p>
              </div>
            </div>
          </div>

          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              void copyForLocalAgent()
            }}
          >
            <label className="grid gap-2 text-sm font-medium text-foreground">
              What should your agent make?
              <Textarea
                value={brief}
                onChange={(event) => setBrief(event.target.value)}
                placeholder={exampleBrief(target)}
                className="min-h-24 resize-y py-3"
                autoFocus
                data-testid="template-agent-brief"
                aria-describedby={error ? "template-agent-error" : undefined}
              />
            </label>

            {error && (
              <p
                id="template-agent-error"
                className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                role="alert"
                data-testid="template-agent-error"
              >
                {error}
              </p>
            )}

            {showHandoff ? (
              <div className="grid gap-2" data-testid="template-agent-handoff-preview">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-medium text-foreground">Agent handoff</p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void copyForLocalAgent()}
                    data-testid="template-agent-copy-again"
                  >
                    <Icon name={copied ? "check" : "copy"} /> {copied ? "Copied" : "Copy again"}
                  </Button>
                </div>
                <Textarea
                  readOnly
                  value={handoff}
                  onFocus={(event) => event.currentTarget.select()}
                  className="min-h-48 resize-y bg-secondary text-sm leading-relaxed"
                  aria-label="Agent handoff to copy"
                  data-testid="template-agent-handoff-text"
                />
              </div>
            ) : null}

            <div className="grid gap-2 rounded-xl border border-dashed px-3 py-2.5 sm:grid-cols-3 sm:gap-3">
              {[
                ["01", "Reads the exact reference"],
                ["02", "Adapts it to your brief"],
                ["03", isContext ? "Creates the new Context" : "Publishes and inspects it"],
              ].map(([step, title]) => (
                <div key={step} className="flex items-center gap-2">
                  <span className="font-mono text-2xs text-muted-foreground">{step}</span>
                  <p className="text-xs font-medium text-foreground">{title}</p>
                </div>
              ))}
            </div>

            {workspaceState.isError ? (
              <StatusPanel
                tone="warning"
                layout="inline"
                title="Native build is temporarily unavailable."
                description="You can still copy this handoff for your local agent."
                action={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void workspaceState.refetch()}
                    data-testid="template-agent-workspace-retry"
                  >
                    Retry
                  </Button>
                }
              />
            ) : null}

            <div className="flex items-center justify-between gap-3 px-1 text-xs">
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                onClick={() => setShowHandoff((visible) => !visible)}
                disabled={!brief.trim() || submitting}
                data-testid="template-agent-preview"
              >
                {showHandoff ? "Hide handoff" : "Preview what gets copied"}
              </Button>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs text-muted-foreground"
                onClick={() => setConnectOpen(true)}
                disabled={submitting}
                data-testid="template-agent-connect"
              >
                Need to connect Derive?
              </Button>
            </div>

            <DialogFooter>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!brief.trim() || !workspace || submitting}
                  onClick={() => void buildInDerive()}
                  data-testid="template-agent-build-beta"
                  title={
                    workspaceState.isError
                      ? "Build in Derive is unavailable while the workspace cannot be loaded"
                      : undefined
                  }
                >
                  <Icon name="sparkles" /> {submitting ? "Starting…" : "Build here · Beta"}
                </Button>
                <Button
                  type="submit"
                  size="lg"
                  disabled={!brief.trim() || submitting}
                  data-testid="template-agent-copy"
                >
                  <Icon name={copied ? "check" : "copy"} />
                  {copied ? "Copied — paste into agent" : "Copy for local agent"}
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
        <ConnectAgentDialogContent testidPrefix="template-agent-connect-dialog" />
      </Dialog>
    </>
  )
}

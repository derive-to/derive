import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useId, useRef, useState } from "react"
import { ApiError, api } from "@/api"
import { Icon } from "@/components/icons"
import { ConnectAgentDialogContent } from "@/components/shared/connect-agent"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useCopy } from "@/lib/clipboard"
import { contextSessionsQuery, contextsQuery } from "@/lib/queries"
import { runnerStatus } from "@/pages/context/runner-status"
import {
  type AgentTemplateTarget,
  type LocalAgentKind,
  localAgentHandoff,
  localAgentLaunchUrl,
} from "./agent-handoff"

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
 * The product handoff from a reusable shape to a local agent job. Every agent
 * receives a portable prompt with the exact URI, without exposing artifact source.
 */
export function AgentTemplateDialog({
  target,
  onOpenChange,
}: {
  target: AgentTemplateTarget | null
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [brief, setBrief] = useState("")
  const [dispatching, setDispatching] = useState(false)
  const [error, setError] = useState("")
  const [planRequired, setPlanRequired] = useState(false)
  const [showHandoff, setShowHandoff] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  const [selectedContext, setSelectedContext] = useState("")
  const [openedAgent, setOpenedAgent] = useState<LocalAgentKind | null>(null)
  const { copied, copy } = useCopy(4000)
  const mounted = useRef(true)
  const descriptionId = useId()
  const contextsState = useQuery(contextsQuery())
  const onlineContexts = (contextsState.data ?? []).filter(
    (context) => runnerStatus(context.runner_seen_at).online,
  )
  const selectedRunner =
    onlineContexts.find((context) => context.id === selectedContext) ?? onlineContexts[0] ?? null
  const busy = dispatching

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
      setPlanRequired(false)
      setShowHandoff(false)
      setConnectOpen(false)
      setOpenedAgent(null)
    }
  }, [target])

  useEffect(() => {
    if (onlineContexts.length && !onlineContexts.some((context) => context.id === selectedContext))
      setSelectedContext(onlineContexts[0]?.id ?? "")
  }, [onlineContexts, selectedContext])

  if (!target) return null
  const isContext = target.kind === "context"

  const handoff = localAgentHandoff(target, brief)

  const copyForLocalAgent = async () => {
    if (!brief.trim() || busy) return
    setError("")
    const ok = await copy(handoff, {
      success: "Copied — paste it into your agent",
      error: null,
    })
    if (!ok) {
      setShowHandoff(true)
      setError("Clipboard access was blocked. Select the handoff below and copy it manually.")
    }
  }

  const openInLocalAgent = (agent: LocalAgentKind) => {
    if (!brief.trim() || busy) return
    const url = localAgentLaunchUrl(agent, target, brief)
    if (!url) {
      setShowHandoff(true)
      setError("This handoff is too detailed for that app’s launch link. Copy it below instead.")
      return
    }
    setError("")
    setOpenedAgent(agent)
    window.location.href = url
  }

  const runOnConnectedMachine = async () => {
    if (!brief.trim() || !selectedRunner || busy) return
    setDispatching(true)
    setError("")
    setPlanRequired(false)
    try {
      await api.askContext(selectedRunner.id, handoff)
      if (!mounted.current) return
      await queryClient.invalidateQueries({
        queryKey: contextSessionsQuery(selectedRunner.id).queryKey,
      })
      onOpenChange(false)
      await navigate({ to: "/contexts/$id", params: { id: selectedRunner.id } })
      // The context console selects the newest conversation, which is this
      // durable queued session. Its normal polling/push path owns progress.
    } catch (cause) {
      if (!mounted.current) return
      if (cause instanceof ApiError && cause.status === 402) {
        setPlanRequired(true)
        return
      }
      setError(
        cause instanceof Error
          ? cause.message
          : `Derive couldn’t send this to ${selectedRunner.name}. Please try again.`,
      )
    } finally {
      if (mounted.current) setDispatching(false)
    }
  }

  return (
    <>
      <Dialog open={!connectOpen} onOpenChange={(open) => !busy && onOpenChange(open)}>
        <DialogContent
          className="max-h-[min(92dvh,760px)] gap-4 overflow-y-auto sm:max-w-2xl"
          aria-describedby={descriptionId}
          aria-busy={busy}
          showCloseButton={!busy}
          onEscapeKeyDown={(event) => busy && event.preventDefault()}
          onPointerDownOutside={(event) => busy && event.preventDefault()}
        >
          <DialogHeader className="pr-7">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <Badge variant="outline" shape="pill">
                <Icon name="sparkles" size={12} /> Use your own agent
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
                ? "Describe the setup, then continue in the local agent you already use. It reads the exact reference and adapts the Context—not a manifest form."
                : "Describe the outcome, then continue in the local agent you already use. It returns a published, inspected draft—not source or a blank form."}
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
              if (selectedRunner) void runOnConnectedMachine()
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

            {contextsState.isError ? (
              <StatusPanel
                tone="warning"
                layout="inline"
                title="Connected-machine pickup is unavailable."
                description="You can still open the prepared task in Codex, Claude Code, or any other local agent below."
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void contextsState.refetch()}
                    data-testid="template-agent-contexts-retry"
                  >
                    Retry
                  </Button>
                }
              />
            ) : null}

            {onlineContexts.length > 0 ? (
              <section
                className="grid gap-3 rounded-xl border bg-secondary/45 p-3.5"
                aria-label="Automatic local pickup"
                data-testid="template-agent-connected-runner"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <span className="size-2 rounded-full bg-success" aria-hidden />
                      Send to this machine
                    </div>
                    <p className="mt-1 text-xs text-pretty text-muted-foreground">
                      Your connected local agent is ready. Send the complete task without copying or
                      switching apps.
                    </p>
                  </div>
                  <Badge variant="outline" shape="pill">
                    Local
                  </Badge>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Select
                    value={selectedRunner?.id ?? ""}
                    onValueChange={setSelectedContext}
                    disabled={busy}
                  >
                    <SelectTrigger
                      className="h-10 w-full sm:flex-1"
                      aria-label="Connected local agent"
                      data-testid="template-agent-runner-select"
                    >
                      <SelectValue placeholder="Choose a connected agent" />
                    </SelectTrigger>
                    <SelectContent>
                      {onlineContexts.map((context) => (
                        <SelectItem key={context.id} value={context.id}>
                          {context.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="submit"
                    size="lg"
                    loading={dispatching}
                    disabled={!brief.trim() || busy}
                    data-testid="template-agent-run-connected"
                  >
                    <Icon name="arrow" />
                    {dispatching ? "Sending…" : `Send to ${selectedRunner?.name ?? "agent"}`}
                  </Button>
                </div>
                {planRequired ? (
                  <StatusPanel
                    tone="warning"
                    layout="inline"
                    title="This machine is online, but it still needs a model plan."
                    description="Connect Codex or Claude once, then send this job again. You can still open the task locally below."
                    action={
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          onOpenChange(false)
                          void navigate({
                            to: "/settings/$section",
                            params: { section: "model-plans" },
                          })
                        }}
                        data-testid="template-agent-connect-plan"
                      >
                        Connect a plan <Icon name="arrow" />
                      </Button>
                    }
                  />
                ) : null}
              </section>
            ) : null}

            <section className="grid gap-2" aria-label="Open in a local agent">
              <div className="flex items-end justify-between gap-3 px-0.5">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {onlineContexts.length > 0 ? "Or open another local agent" : "Continue locally"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Choose your agent. The complete task is prepared for you—no source code or setup
                    form.
                  </p>
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <Button
                  type="button"
                  variant={openedAgent === "codex" ? "secondary" : "outline"}
                  size="lg"
                  className="justify-between"
                  disabled={!brief.trim() || busy}
                  onClick={() => openInLocalAgent("codex")}
                  data-testid="template-agent-open-codex"
                >
                  <span className="grid min-w-0 gap-0.5 text-left">
                    <span className="flex items-center gap-2 font-medium">
                      <Icon name="context" /> Codex
                    </span>
                    <span className="text-xs font-normal text-muted-foreground">Open task</span>
                  </span>
                  <Icon name={openedAgent === "codex" ? "check" : "arrow"} />
                </Button>
                <Button
                  type="button"
                  variant={openedAgent === "claude-code" ? "secondary" : "outline"}
                  size="lg"
                  className="justify-between"
                  disabled={!brief.trim() || busy}
                  onClick={() => openInLocalAgent("claude-code")}
                  data-testid="template-agent-open-claude"
                >
                  <span className="grid min-w-0 gap-0.5 text-left">
                    <span className="flex items-center gap-2 font-medium">
                      <Icon name="context" /> Claude Code
                    </span>
                    <span className="text-xs font-normal text-muted-foreground">Open task</span>
                  </span>
                  <Icon name={openedAgent === "claude-code" ? "check" : "arrow"} />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="justify-between"
                  disabled={!brief.trim() || busy}
                  onClick={() => void copyForLocalAgent()}
                  data-testid="template-agent-copy"
                >
                  <span className="grid min-w-0 gap-0.5 text-left">
                    <span className="flex items-center gap-2 font-medium">
                      <Icon name="copy" /> Any agent
                    </span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {copied ? "Ready to paste" : "Copy task"}
                    </span>
                  </span>
                  <Icon name={copied ? "check" : "arrow"} />
                </Button>
              </div>
              {openedAgent ? (
                <p className="px-0.5 text-xs text-success" role="status">
                  Opened {openedAgent === "codex" ? "Codex" : "Claude Code"} — the task is ready for
                  you to review and send.
                </p>
              ) : null}
            </section>

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
                    <Icon name={copied ? "check" : "copy"} /> {copied ? "Copied" : "Copy task"}
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

            <div className="flex items-center justify-between gap-3 px-1 text-xs">
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                onClick={() => setShowHandoff((visible) => !visible)}
                disabled={!brief.trim() || busy}
                data-testid="template-agent-preview"
              >
                {showHandoff ? "Hide agent instructions" : "Review agent instructions"}
              </Button>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs text-muted-foreground"
                onClick={() => setConnectOpen(true)}
                disabled={busy}
                data-testid="template-agent-connect"
              >
                Connect Derive to your agent
              </Button>
            </div>

            {onlineContexts.length === 0 ? (
              <div
                className="flex flex-col gap-2 rounded-xl border border-dashed px-3.5 py-3 sm:flex-row sm:items-center"
                data-testid="template-agent-no-runner"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-foreground">
                    Want one-click pickup later?
                  </p>
                  <p className="mt-0.5 text-xs text-pretty text-muted-foreground">
                    Connect this machine once and future template tasks can arrive automatically.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onOpenChange(false)
                    void navigate({ to: "/contexts" })
                  }}
                  data-testid="template-agent-setup-runner"
                >
                  Connect this machine <Icon name="arrow" />
                </Button>
              </div>
            ) : null}
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
        <ConnectAgentDialogContent testidPrefix="template-agent-connect-dialog" />
      </Dialog>
    </>
  )
}

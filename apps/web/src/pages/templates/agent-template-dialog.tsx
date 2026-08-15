import { Icon } from "@/components/icons"
import { ConnectAgentButton } from "@/components/shared/connect-agent"
import { FormField } from "@/components/shared/form-field"
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
import type { AgentTemplateTarget } from "./agent-handoff"
import { useAgentTemplateHandoff } from "./use-agent-template-handoff"

export type { AgentTemplateTarget } from "./agent-handoff"

const LOCAL_AGENTS = [
  { id: "codex", label: "Codex", launch: "codex", icon: "context" },
  { id: "claude", label: "Claude Code", launch: "claude-code", icon: "context" },
  { id: "any", label: "Any agent", launch: null, icon: "copy" },
] as const

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
  if (!target) return null
  return <AgentTemplateDialogInner key={target.uri} target={target} onOpenChange={onOpenChange} />
}

function AgentTemplateDialogInner({
  target,
  onOpenChange,
}: {
  target: AgentTemplateTarget
  onOpenChange: (open: boolean) => void
}) {
  const {
    brief,
    setBrief,
    busy,
    dispatching,
    error,
    planRequired,
    showHandoff,
    setSelectedContext,
    copied,
    descriptionId,
    contextsState,
    connectedAgentsState,
    onlineContexts,
    selectedRunner,
    activeWorkspace,
    launchReceipt,
    handoff,
    copyForLocalAgent,
    openInLocalAgent,
    runOnConnectedMachine,
    openModelPlans,
  } = useAgentTemplateHandoff(target, onOpenChange)

  const isContext = target.kind === "context"

  return (
    <Dialog open onOpenChange={(open) => !busy && onOpenChange(open)}>
      <DialogContent
        className="max-h-[min(92dvh,760px)] gap-3 overflow-y-auto sm:max-w-2xl"
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
              {target.outcome ? (
                <p className="mt-1.5 text-xs text-pretty text-foreground">{target.outcome}</p>
              ) : null}
            </div>
          </div>
          {target.sections?.length ? (
            <div
              className="mt-2.5 border-t pt-2.5"
              data-testid="template-agent-inheritance-preview"
            >
              <p className="font-mono text-2xs uppercase tracking-wider text-muted-foreground">
                Your agent inherits the shape—not the answers
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {target.sections.slice(0, 6).map((section) => (
                  <span
                    key={section}
                    className="rounded-md border bg-background/70 px-2 py-0.5 text-xs text-foreground"
                  >
                    {section}
                  </span>
                ))}
                {target.sections.length > 6 ? (
                  <span className="px-1 py-1 text-xs text-muted-foreground">
                    +{target.sections.length - 6} more
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (selectedRunner) void runOnConnectedMachine()
          }}
        >
          <FormField
            label="What should your agent make?"
            htmlFor="template-agent-brief-field"
            error={error ? <span data-testid="template-agent-error">{error}</span> : undefined}
          >
            <Textarea
              id="template-agent-brief-field"
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              placeholder={exampleBrief(target)}
              className="min-h-20 resize-y py-3"
              autoFocus
              data-testid="template-agent-brief"
            />
          </FormField>

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

          {onlineContexts.length === 0 &&
          !connectedAgentsState.isPending &&
          connectedAgentsState.data?.length === 0 ? (
            <StatusPanel
              tone="warning"
              layout="inline"
              icon={<Icon name="context" />}
              title="Connect Derive before the handoff"
              description="This task uses find, read, and publish in your active workspace. Connect once so the local agent can resolve the reference and return the result."
              action={
                <ConnectAgentButton
                  variant="outline"
                  size="sm"
                  testId="template-agent-connect-derive"
                />
              }
            />
          ) : onlineContexts.length === 0 && connectedAgentsState.isError ? (
            <StatusPanel
              tone="warning"
              layout="inline"
              title="Derive connection could not be confirmed"
              description="You can continue if this agent already uses Derive, or retry the connection check."
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void connectedAgentsState.refetch()}
                  data-testid="template-agent-connection-retry"
                >
                  Retry
                </Button>
              }
            />
          ) : onlineContexts.length === 0 && connectedAgentsState.data?.length ? (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-secondary/45 px-3 py-2.5 text-xs"
              data-testid="template-agent-preflight"
            >
              <span className="flex items-center gap-2 font-medium text-foreground">
                <span className="size-2 rounded-full bg-success" aria-hidden />
                Derive connection detected
              </span>
              {activeWorkspace ? (
                <span className="text-muted-foreground">
                  Publishing to <span className="text-foreground">{activeWorkspace.name}</span>
                </span>
              ) : null}
            </div>
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
                      onClick={openModelPlans}
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
              {LOCAL_AGENTS.map((agent) => {
                const copyAction = agent.launch === null
                return (
                  <Button
                    key={agent.id}
                    type="button"
                    variant="outline"
                    size="lg"
                    className="justify-between"
                    disabled={!brief.trim() || busy}
                    onClick={() =>
                      copyAction ? void copyForLocalAgent() : void openInLocalAgent(agent.launch)
                    }
                    data-testid={
                      copyAction ? "template-agent-copy" : `template-agent-open-${agent.id}`
                    }
                  >
                    <span className="grid min-w-0 gap-0.5 text-left">
                      <span className="flex items-center gap-2 font-medium">
                        <Icon name={agent.icon} /> {agent.label}
                      </span>
                      <span className="text-xs font-normal text-muted-foreground">
                        {copyAction && copied
                          ? "Ready to paste"
                          : copyAction
                            ? "Copy task"
                            : launchReceipt?.agent === agent.label
                              ? "Open again"
                              : "Open task"}
                      </span>
                    </span>
                    <Icon name={copyAction && copied ? "check" : "arrow"} />
                  </Button>
                )
              })}
            </div>
          </section>

          {launchReceipt ? (
            <StatusPanel
              tone="brand"
              layout="inline"
              icon={<Icon name="check" />}
              title={`${launchReceipt.agent} task prepared`}
              description={
                launchReceipt.fallbackCopied
                  ? `${launchReceipt.agent} should open in a new composer. The complete task is also copied, so you can paste it if the app did not open.`
                  : `${launchReceipt.agent} should open in a new composer. Clipboard access was blocked, so the complete task is available below if the app did not open.`
              }
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void copyForLocalAgent()}
                  data-testid="template-agent-launch-copy-fallback"
                >
                  <Icon name="copy" /> {launchReceipt.fallbackCopied ? "Copy again" : "Copy task"}
                </Button>
              }
            />
          ) : null}

          {showHandoff ? (
            <div className="grid gap-2" data-testid="template-agent-handoff-preview">
              <p className="text-xs font-medium text-foreground">Prepared task</p>
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
        </form>
      </DialogContent>
    </Dialog>
  )
}

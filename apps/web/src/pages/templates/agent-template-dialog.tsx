import { Icon } from "@/components/icons"
import { FormField } from "@/components/shared/form-field"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import type { AgentTemplateTarget } from "./agent-handoff"
import { useAgentTemplateHandoff } from "./use-agent-template-handoff"

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
  const { brief, setBrief, error, showHandoff, copied, descriptionId, handoff, copyForLocalAgent } =
    useAgentTemplateHandoff(target)

  const isContext = target.kind === "context"

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[min(92dvh,760px)] gap-3 overflow-y-auto sm:max-w-2xl"
        aria-describedby={descriptionId}
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

        <form className="grid gap-3" onSubmit={(event) => event.preventDefault()}>
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

          <section className="grid gap-2" aria-label="Copy for a local agent">
            <div className="px-0.5">
              <p className="text-sm font-medium text-foreground">Continue in your agent</p>
              <p className="text-xs text-muted-foreground">
                Copy the complete prompt, then paste it into Codex, Claude Code, or any other agent.
              </p>
            </div>
            <Button
              type="button"
              size="lg"
              className="w-full justify-between"
              disabled={!brief.trim()}
              onClick={() => void copyForLocalAgent()}
              data-testid="template-agent-copy"
            >
              <span className="flex items-center gap-2 font-medium">
                <Icon name={copied ? "check" : "copy"} />
                {copied ? "Copied — paste into your agent" : "Copy as prompt"}
              </span>
              <Icon name={copied ? "check" : "arrow"} />
            </Button>
          </section>

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

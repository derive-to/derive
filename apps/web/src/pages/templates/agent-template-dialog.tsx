import { Icon } from "@/components/icons"
import { FormField } from "@/components/shared/form-field"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { SectionTitle } from "@/components/shared/section-title"
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
  if (target.kind === "context") return "What should this Agent help your team know or do?"
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

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[min(92dvh,760px)] gap-3 overflow-y-auto sm:max-w-2xl"
        aria-describedby={descriptionId}
      >
        <DialogHeader className="pr-7">
          <Eyebrow as="div" className="mb-1">
            {target.kind === "context" ? "Context" : target.category}
          </Eyebrow>
          <DialogTitle className="font-serif text-2xl tracking-tight [overflow-wrap:anywhere]">
            Use {target.title}
          </DialogTitle>
          <DialogDescription id={descriptionId} className="max-w-lg">
            Describe what you need. Derive will prepare a prompt for your agent.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border bg-secondary/45 p-3">
          <p className="text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
            {target.description}
          </p>
          {target.sections?.length ? (
            <div className="mt-3" data-testid="template-agent-inheritance-preview">
              <SectionTitle as="h4">Included sections</SectionTitle>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {target.sections.slice(0, 6).map((section) => (
                  <p
                    key={section}
                    className="rounded-md border bg-background/70 px-2 py-0.5 text-xs text-foreground"
                  >
                    {section}
                  </p>
                ))}
                {target.sections.length > 6 ? (
                  <p className="px-1 py-1 text-xs text-muted-foreground">
                    +{target.sections.length - 6} more
                  </p>
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

          <Button
            type="button"
            size="lg"
            className="w-full"
            disabled={!brief.trim()}
            onClick={() => void copyForLocalAgent()}
            data-testid="template-agent-copy"
          >
            <Icon name={copied ? "check" : "copy"} />
            {copied ? "Copied. Paste into your agent." : "Copy as prompt"}
          </Button>

          {showHandoff ? (
            <div className="grid gap-2" data-testid="template-agent-handoff-preview">
              <SectionTitle as="h4">Prepared task</SectionTitle>
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

import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useId, useState } from "react"
import { api } from "@/api"
import { Icon } from "@/components/icons"
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
import { workspaceQuery } from "@/lib/queries"

export type AgentTemplateTarget = {
  uri: string
  title: string
  description: string
  kind: "artifact" | "context"
  category: string
  inputs?: ReadonlyArray<{ name: string; description: string; required?: boolean }>
}

const exampleBrief = (target: AgentTemplateTarget) => {
  const namedInputs = target.inputs?.slice(0, 3).map((input) => input.name.toLowerCase()) ?? []
  if (namedInputs.length)
    return `What are you making? Include ${namedInputs.join(", ")}, plus anything Derive should know.`
  if (target.kind === "context")
    return "What should this context help your team’s agents know or do?"
  if (target.category === "Deck")
    return "Tell Derive the story, audience, and outcome you want from this deck."
  return "Describe what you want to make, who it is for, and what a strong result should accomplish."
}

const buildRequest = (target: AgentTemplateTarget, brief: string) =>
  `Use the ${target.title} template to make this mine: ${brief.trim()}\n\nFind and use relevant evidence from this workspace when it helps. Build a polished first draft, publish it, inspect the rendered result, and show me what you made.`

/**
 * The product handoff from a reusable shape to an agent job. The internal URI
 * travels separately from the person's prose, so the model gets an exact,
 * trusted template reference without making product users look at machinery.
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
  const descriptionId = useId()
  const workspaceState = useQuery(workspaceQuery())
  const workspace = workspaceState.data

  useEffect(() => {
    if (target) {
      setBrief("")
      setError("")
    }
  }, [target])

  if (!target) return null
  const isContext = target.kind === "context"

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="gap-5 sm:max-w-xl" aria-describedby={descriptionId}>
        <DialogHeader className="pr-7">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Badge variant="outline" shape="pill">
              <Icon name="sparkles" size={12} /> Derive will build it
            </Badge>
            <span className="font-mono text-2xs uppercase tracking-wider text-muted-foreground">
              {isContext ? "Context" : target.category}
            </span>
          </div>
          <DialogTitle className="font-serif text-2xl tracking-tight">
            Make {target.title} yours
          </DialogTitle>
          <DialogDescription id={descriptionId} className="max-w-lg">
            Tell Derive what you need. It will use this template as the shape, find useful workspace
            evidence, and return a published first draft—not an empty form to fill in.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border bg-secondary/45 p-3.5">
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

        {workspaceState.isError ? (
          <StatusPanel
            tone="danger"
            layout="inline"
            title="Derive couldn’t load this workspace."
            description="Retry before starting this draft. Your brief will stay here."
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

        <form
          className="grid gap-4"
          onSubmit={async (event) => {
            event.preventDefault()
            if (!brief.trim() || !workspace || submitting) return
            setSubmitting(true)
            setError("")
            try {
              const created = await api.createChatSession({
                workspace: workspace.id,
                body_md: buildRequest(target, brief),
                ...(isContext ? { purpose: "context_builder" as const } : {}),
                template_start: { uri: target.uri, title: target.title, kind: target.kind },
              })
              await navigate({
                to: "/chat",
                search: { session: created.session.id, model: undefined, ask: undefined },
              })
            } catch (cause) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Derive couldn’t start this draft. Please try again.",
              )
            } finally {
              setSubmitting(false)
            }
          }}
        >
          <label className="grid gap-2 text-sm font-medium text-foreground">
            What should Derive make?
            <Textarea
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              placeholder={exampleBrief(target)}
              className="min-h-32 resize-y py-3"
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

          <div className="grid gap-2 rounded-xl border border-dashed px-3.5 py-3 sm:grid-cols-3 sm:gap-3">
            {[
              ["01", "Uses the template", "Keeps its proven structure and visual language."],
              ["02", "Makes it specific", "Finds relevant facts and adapts them to your brief."],
              ["03", "Shows real work", "Publishes and inspects a finished first draft."],
            ].map(([step, title, detail]) => (
              <div key={step} className="grid grid-cols-[auto_1fr] gap-2 sm:block">
                <span className="font-mono text-2xs text-muted-foreground">{step}</span>
                <div className="sm:mt-1">
                  <p className="text-xs font-medium text-foreground">{title}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{detail}</p>
                </div>
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              data-testid="template-agent-cancel"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="lg"
              disabled={!brief.trim() || !workspace || submitting}
              data-testid="template-agent-go"
            >
              <Icon name="sparkles" />{" "}
              {submitting ? "Starting…" : isContext ? "Set up with Derive" : "Build with Derive"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

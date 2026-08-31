import { useMemo, useState } from "react"
import { Icon, type IconName } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

export type WorkflowShape = "handoff" | "loop" | "decision"

export interface WorkflowDraft {
  outcome: string
  shape: WorkflowShape
  maxAttempts: number
  testOnly: boolean
  gateExternalEffects: boolean
  finalReview: boolean
}

const DEFAULT_DRAFT: WorkflowDraft = {
  outcome: "",
  shape: "loop",
  maxAttempts: 2,
  testOnly: true,
  gateExternalEffects: true,
  finalReview: false,
}

const SHAPES: Array<{
  id: WorkflowShape
  icon: IconName
  title: string
  description: string
}> = [
  { id: "handoff", icon: "arrow", title: "Handoff", description: "One step follows another." },
  {
    id: "loop",
    icon: "workflow",
    title: "Improve until ready",
    description: "Try, check, and revise within a bound.",
  },
  {
    id: "decision",
    icon: "review",
    title: "Human decision",
    description: "Pause before a key branch or action.",
  },
]

export const workflowBuilderPrompt = (draft: WorkflowDraft): string => {
  const shape =
    draft.shape === "handoff"
      ? "Use the smallest useful linear handoff."
      : draft.shape === "decision"
        ? "Include one explicit human decision with clear options."
        : "Use a bounded evaluator and improvement loop."
  const boundaries = [
    draft.testOnly ? "Keep all writes in test or draft surfaces." : null,
    draft.gateExternalEffects
      ? "Require a human decision before consequential effects outside Derive."
      : null,
    draft.finalReview ? "Add a final human review before the terminal result." : null,
  ].filter(Boolean)

  return [
    "Create a new workflow in this Derive workspace.",
    `Outcome: ${draft.outcome.trim()}`,
    shape,
    draft.shape === "loop" ? `Stop after at most ${draft.maxAttempts} attempts.` : null,
    boundaries.length ? `Boundaries: ${boundaries.join(" ")}` : null,
    "Show one workflow Preview, repair any blockers, then create the workflow as a draft.",
    "Do not run it yet.",
  ]
    .filter(Boolean)
    .join("\n")
}

function StepRail({ current }: { current: number }) {
  return (
    <ol className="grid grid-cols-4 gap-2" aria-label="Workflow builder progress">
      {["Outcome", "Shape", "Safety", "Preview"].map((label, index) => (
        <li
          key={label}
          className={cn(
            "flex min-w-0 flex-col gap-1 font-mono text-2xs text-muted-foreground",
            index <= current && "text-foreground",
          )}
          aria-current={index === current ? "step" : undefined}
        >
          <span
            aria-hidden
            className={cn("h-0.5 rounded-full bg-border", index <= current && "bg-primary")}
          />
          <span className="truncate">
            {index + 1}. {label}
          </span>
        </li>
      ))}
    </ol>
  )
}

function SafetyRow({
  checked,
  onChange,
  title,
  description,
  testId,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  title: string
  description: string
  testId: string
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border bg-card p-3 hover:bg-accent">
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
        data-testid={testId}
        className="mt-0.5"
      />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  )
}

export function WorkflowBuilderDialog({
  open,
  onOpenChange,
  onBuild,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onBuild: (prompt: string) => void
}) {
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<WorkflowDraft>(DEFAULT_DRAFT)
  const prompt = useMemo(() => workflowBuilderPrompt(draft), [draft])
  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setStep(0)
      setDraft(DEFAULT_DRAFT)
    }
  }
  const finish = () => {
    onBuild(prompt)
    close(false)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-2xl" data-testid="workflow-builder-dialog">
        <DialogHeader>
          <DialogTitle>Create a workflow</DialogTitle>
          <DialogDescription>
            Start with the result. You can inspect and edit the draft before anything runs.
          </DialogDescription>
        </DialogHeader>
        <StepRail current={step} />
        <div className="min-h-0 py-2 sm:min-h-72">
          {step === 0 ? (
            <div className="flex flex-col gap-4" data-testid="workflow-builder-outcome">
              <div>
                <h2 className="font-serif text-xl font-medium tracking-tight">
                  What should happen?
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Describe a result as if you were briefing a teammate.
                </p>
              </div>
              <Textarea
                autoFocus
                value={draft.outcome}
                onChange={(event) => setDraft({ ...draft, outcome: event.target.value })}
                placeholder="For example: Review a pull request, fix material issues, and verify that it is ready."
                aria-label="Workflow outcome"
                data-testid="workflow-builder-outcome-input"
                className="min-h-32"
              />
            </div>
          ) : null}
          {step === 1 ? (
            <div className="flex flex-col gap-4" data-testid="workflow-builder-shape">
              <div>
                <h2 className="font-serif text-xl font-medium tracking-tight">
                  Choose a simple shape
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Derive will turn this into explicit steps and routes.
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                {SHAPES.map((shape) => (
                  <button
                    key={shape.id}
                    type="button"
                    data-testid={`workflow-builder-shape-${shape.id}`}
                    aria-pressed={draft.shape === shape.id}
                    onClick={() => setDraft({ ...draft, shape: shape.id })}
                    className={cn(
                      "flex min-h-0 flex-col items-start gap-2 rounded-xl border bg-card p-3 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-32",
                      draft.shape === shape.id && "border-primary ring-2 ring-primary/20",
                    )}
                  >
                    <span className="grid size-8 place-items-center rounded-lg bg-secondary">
                      <Icon name={shape.icon} />
                    </span>
                    <span className="font-medium">{shape.title}</span>
                    <span className="text-xs text-muted-foreground">{shape.description}</span>
                  </button>
                ))}
              </div>
              {draft.shape === "loop" ? (
                <label className="flex items-center gap-3 rounded-xl border bg-secondary/30 p-3 text-sm">
                  <span className="font-medium">Maximum attempts</span>
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    value={draft.maxAttempts}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        maxAttempts: Math.max(1, Math.min(10, Number(event.target.value) || 1)),
                      })
                    }
                    aria-label="Maximum attempts"
                    data-testid="workflow-builder-attempts"
                    className="ml-auto w-20"
                  />
                </label>
              ) : null}
            </div>
          ) : null}
          {step === 2 ? (
            <div className="flex flex-col gap-4" data-testid="workflow-builder-safety">
              <div>
                <h2 className="font-serif text-xl font-medium tracking-tight">
                  Set the boundaries
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  These rules become part of the workflow draft.
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <SafetyRow
                  checked={draft.testOnly}
                  onChange={(testOnly) => setDraft({ ...draft, testOnly })}
                  title="Use test or draft surfaces"
                  description="Keep writes away from production and final delivery surfaces."
                  testId="workflow-builder-test-only"
                />
                <SafetyRow
                  checked={draft.gateExternalEffects}
                  onChange={(gateExternalEffects) => setDraft({ ...draft, gateExternalEffects })}
                  title="Ask before consequential actions"
                  description="Pause before messages, spending, access changes, or production writes."
                  testId="workflow-builder-gate-effects"
                />
                <SafetyRow
                  checked={draft.finalReview}
                  onChange={(finalReview) => setDraft({ ...draft, finalReview })}
                  title="Request final human review"
                  description="Add an explicit decision before the terminal result."
                  testId="workflow-builder-final-review"
                />
              </div>
            </div>
          ) : null}
          {step === 3 ? (
            <div className="flex flex-col gap-4" data-testid="workflow-builder-preview">
              <div>
                <h2 className="font-serif text-xl font-medium tracking-tight">
                  Preview before you create
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Derive will validate the full definition before it creates the draft.
                </p>
              </div>
              <div className="rounded-xl border bg-secondary/30 p-4">
                <div className="flex items-start gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-card ring-1 ring-border">
                    <Icon
                      name={
                        draft.shape === "loop"
                          ? "workflow"
                          : draft.shape === "decision"
                            ? "review"
                            : "arrow"
                      }
                    />
                  </span>
                  <div className="min-w-0">
                    <p className="font-medium">{draft.outcome.trim()}</p>
                    <p className="mt-1 font-mono text-2xs text-muted-foreground">
                      {SHAPES.find((shape) => shape.id === draft.shape)?.title}
                      {draft.shape === "loop" ? ` · ${draft.maxAttempts} attempts maximum` : ""}
                    </p>
                  </div>
                  <span className="ml-auto shrink-0 rounded-full bg-success/10 px-2 py-1 font-mono text-2xs text-success">
                    Ready to draft
                  </span>
                </div>
                <pre className="mt-4 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-card p-3 font-mono text-2xs text-muted-foreground">
                  {prompt}
                </pre>
              </div>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          {step > 0 ? (
            <Button
              variant="outline"
              onClick={() => setStep((current) => current - 1)}
              data-testid="workflow-builder-back"
            >
              Back
            </Button>
          ) : null}
          <span className="mr-auto self-center text-xs text-muted-foreground">
            Nothing runs until you choose Run.
          </span>
          {step < 3 ? (
            <Button
              onClick={() => setStep((current) => current + 1)}
              disabled={step === 0 && draft.outcome.trim().length < 9}
              data-testid="workflow-builder-next"
            >
              Continue
            </Button>
          ) : (
            <Button onClick={finish} data-testid="workflow-builder-finish">
              <Icon name="sparkles" /> Build with Derive
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

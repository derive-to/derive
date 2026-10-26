import { useQuery } from "@tanstack/react-query"
import {
  Check,
  CircleDot,
  Clock,
  GitCommitHorizontal,
  GitPullRequest,
  type LucideIcon,
  MessageSquare,
  Tag,
  Workflow,
} from "lucide-react"
import { type ReactNode, useState } from "react"
import { type AgentDetail, type AgentTrigger, api, type GithubTriggerOn } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { githubRepositoriesQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { cn } from "@/lib/utils"
import { cronLabel, firstLine } from "./format"
import { Field, Segmented, Sub, Verb } from "./rows"

// What starts an agent without anyone asking: a schedule, or something happening on GitHub.
// One list, one row grammar, one form that switches between the two.

type GithubEvent = GithubTriggerOn["github"]["event"]

/** Each event in plain words, the actions a person picks from, and what a branch filter
 *  compares (or null where branches don't apply). */
const EVENTS: Record<
  GithubEvent,
  {
    label: string
    actions: { value: string; label: string; chip?: string }[]
    branches: string | null
  }
> = {
  pull_request: {
    label: "Pull request",
    actions: [
      { value: "opened", label: "Opened" },
      { value: "synchronize", label: "New commits" },
      { value: "ready_for_review", label: "Ready for review", chip: "Ready" },
      { value: "reopened", label: "Reopened" },
      { value: "merged", label: "Merged" },
      { value: "review_requested", label: "Review requested" },
    ],
    branches: "Base branches",
  },
  push: { label: "Push", actions: [], branches: "Branches" },
  pull_request_review: {
    label: "Review",
    actions: [
      { value: "submitted", label: "Submitted" },
      { value: "edited", label: "Edited" },
    ],
    branches: "Base branches",
  },
  issues: {
    label: "Issue",
    actions: [
      { value: "opened", label: "Opened" },
      { value: "labeled", label: "Labeled" },
      { value: "closed", label: "Closed" },
      { value: "reopened", label: "Reopened" },
    ],
    branches: null,
  },
  issue_comment: {
    label: "Comment",
    actions: [
      { value: "created", label: "Posted" },
      { value: "edited", label: "Edited" },
    ],
    branches: null,
  },
  release: {
    label: "Release",
    actions: [
      { value: "published", label: "Published" },
      { value: "released", label: "Released" },
    ],
    branches: null,
  },
  workflow_run: {
    label: "Workflow run",
    actions: [
      { value: "completed", label: "Completed" },
      { value: "requested", label: "Started" },
    ],
    branches: "Branches",
  },
}

const NOUN: Record<GithubEvent, string> = {
  pull_request: "pull request",
  push: "push",
  pull_request_review: "review",
  issues: "issue",
  issue_comment: "comment",
  release: "release",
  workflow_run: "workflow run",
}

/** "Pull request opened, new commits or merged", "Any push". */
const eventTitle = (on: GithubTriggerOn): string => {
  const g = on.github
  const spec = EVENTS[g.event]
  const picked = spec.actions
    .filter((a) => g.actions?.includes(a.value))
    .map((a) => a.label.toLowerCase())
  if (!picked.length) return `Any ${NOUN[g.event]}`
  const last = picked.pop()
  return `${spec.label} ${picked.length ? `${picked.join(", ")} or ${last}` : last}`
}

const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"

const KIND_ICON: Record<GithubEvent, LucideIcon> = {
  pull_request: GitPullRequest,
  pull_request_review: GitPullRequest,
  push: GitCommitHorizontal,
  issues: CircleDot,
  issue_comment: MessageSquare,
  release: Tag,
  workflow_run: Workflow,
}

export function TriggersField({ agent, edit }: { agent: AgentDetail; edit: boolean }) {
  const [editing, setEditing] = useState<AgentTrigger | "new" | null>(null)
  // Set-up still needed at GitHub, as the server said on save, until the person moves on.
  const [notices, setNotices] = useState<Record<string, string>>({})
  const done = (saved?: AgentTrigger) => {
    if (saved?.notice) setNotices((n) => ({ ...n, [saved.id]: saved.notice ?? "" }))
    setEditing(null)
  }
  return (
    <Field
      label="Starts"
      action={
        edit &&
        !editing && (
          <Verb testId="agent-trigger-add" onClick={() => setEditing("new")}>
            Add
          </Verb>
        )
      }
    >
      {agent.triggers.length === 0 && !editing && (
        <span className="text-muted-foreground">Only when someone asks</span>
      )}
      <ul role="list" className="flex flex-col">
        {agent.triggers.map((t) =>
          editing !== "new" && editing?.id === t.id ? (
            <li key={t.id}>
              <TriggerForm agent={agent} trigger={t} onDone={done} />
            </li>
          ) : (
            <TriggerRow
              key={t.id}
              trigger={t}
              notice={notices[t.id]}
              onEdit={edit && !editing ? () => setEditing(t) : undefined}
            />
          ),
        )}
      </ul>
      {editing === "new" && <TriggerForm agent={agent} onDone={done} />}
    </Field>
  )
}

function TriggerRow({
  trigger: t,
  notice,
  onEdit,
}: {
  trigger: AgentTrigger
  notice?: string
  onEdit?: () => void
}) {
  const Glyph = t.on ? KIND_ICON[t.on.github.event] : Clock
  const detail = t.on
    ? [
        t.on.github.branches?.join(", "),
        t.on.github.reviewers?.join(", "),
        t.on.github.drafts ? "drafts too" : null,
      ]
    : [t.tz]
  return (
    <li
      data-testid={`agent-trigger-${t.id}`}
      className="flex items-start gap-3 border-t border-border-soft py-2.5 first:border-t-0 first:pt-0.5"
    >
      <Glyph
        aria-hidden="true"
        className={cn(
          "mt-1 size-4 shrink-0",
          t.enabled ? "text-foreground" : "text-muted-foreground",
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("text-pretty", !t.enabled && "text-muted-foreground")}>
          {t.on ? eventTitle(t.on) : t.cron ? cronLabel(t.cron) : "Schedule"}
          {!t.enabled && (
            <span className="ml-2 rounded-sm bg-secondary px-1.5 py-0.5 align-middle text-2xs font-mono tracking-wide text-muted-foreground uppercase">
              Paused
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-baseline gap-1.5 text-sm text-muted-foreground">
          {[
            t.on ? (
              <span key="repo" className="shrink-0 font-mono text-xs">
                {t.on.github.repository}
              </span>
            ) : null,
            ...detail.filter(Boolean).map((d) => (
              <span key={d} className="shrink-0">
                {d}
              </span>
            )),
            <span key="what" className="truncate">
              {firstLine(t.instruction)}
            </span>,
          ]
            .filter(Boolean)
            .flatMap((part, i) =>
              i
                ? [
                    <span key={`dot-${i}`} aria-hidden="true" className="shrink-0">
                      ·
                    </span>,
                    part,
                  ]
                : [part],
            )}
        </span>
        {notice && <SetupNotice text={notice} testId={t.id} />}
      </div>
      {onEdit && (
        <Verb testId={`agent-trigger-edit-${t.id}`} onClick={onEdit}>
          Edit
        </Verb>
      )}
    </li>
  )
}

/** The server's set-up note, with its GitHub settings link made a link. */
function SetupNotice({ text, testId }: { text: string; testId: string }) {
  const url = text.match(/https:\/\/github\.com\/\S+/)?.[0]
  return (
    <p
      data-testid={`agent-trigger-notice-${testId}`}
      className="mt-1 rounded-md bg-warning/10 px-2.5 py-1.5 text-sm text-pretty text-foreground"
    >
      {url ? text.slice(0, text.indexOf(url)).replace(/ at $/, ".") : text}{" "}
      {url && (
        <a href={url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          Open GitHub settings
        </a>
      )}
    </p>
  )
}

function TriggerForm({
  agent,
  trigger,
  onDone,
}: {
  agent: AgentDetail
  trigger?: AgentTrigger
  onDone: (saved?: AgentTrigger) => void
}) {
  const github = agent.sources.find((s) => s.kind === "github_app" && s.status === "active")
  const [kind, setKind] = useState<"schedule" | "github">(
    trigger ? (trigger.kind === "event" ? "github" : "schedule") : github ? "github" : "schedule",
  )
  const [instruction, setInstruction] = useState(trigger?.instruction ?? "")
  const manage = trigger ? <ManageTrigger trigger={trigger} onDone={() => onDone()} /> : null
  return (
    <div
      data-testid="agent-trigger-form"
      className="my-1 flex flex-col gap-3 rounded-lg bg-secondary/40 p-3"
    >
      {!trigger && (
        <Segmented
          testId="agent-trigger-kind"
          value={kind}
          onChange={(v) => setKind(v as typeof kind)}
          options={[
            { value: "github", label: "GitHub event", disabled: !github },
            { value: "schedule", label: "Schedule" },
          ]}
        />
      )}
      {!trigger && !github && (
        <Sub>Add a GitHub source under Sources to start it from pull requests and pushes.</Sub>
      )}
      {kind === "github" && github ? (
        <GithubForm
          sourceId={github.id}
          trigger={trigger}
          instruction={instruction}
          setInstruction={setInstruction}
          agentId={agent.id}
          manage={manage}
          onDone={onDone}
        />
      ) : (
        <ScheduleForm
          agentId={agent.id}
          trigger={trigger}
          instruction={instruction}
          setInstruction={setInstruction}
          manage={manage}
          onDone={onDone}
        />
      )}
    </div>
  )
}

type FormProps = {
  agentId: string
  trigger?: AgentTrigger
  instruction: string
  setInstruction: (v: string) => void
  /** Pause and remove, for a trigger that exists. */
  manage?: ReactNode
  onDone: (saved?: AgentTrigger) => void
}

function InstructionBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="What it does each time"
      aria-label="Instruction"
      data-testid="agent-trigger-instruction"
      className="min-h-20"
    />
  )
}

function FormActions({
  ready,
  saving,
  onCancel,
  manage,
}: {
  ready: boolean
  saving: boolean
  onCancel: () => void
  manage?: ReactNode
}) {
  return (
    <div className="flex items-center gap-2">
      <Button
        type="submit"
        size="xs"
        data-testid="agent-trigger-save"
        disabled={!ready}
        loading={saving}
      >
        {saving ? "Saving…" : "Save"}
      </Button>
      <Verb testId="agent-trigger-cancel" onClick={onCancel}>
        Cancel
      </Verb>
      {manage && <span className="ml-auto flex items-center">{manage}</span>}
    </div>
  )
}

/** Pause or remove an existing trigger, from inside its form. */
function ManageTrigger({ trigger, onDone }: { trigger: AgentTrigger; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const invalidate = [["agents"]]
  const toggle = useApiMutation({
    mutationFn: () => api.updateTrigger(trigger.id, { enabled: !trigger.enabled }),
    invalidate,
    onSuccess: onDone,
  })
  const remove = useApiMutation({
    mutationFn: () => api.deleteTrigger(trigger.id),
    invalidate,
    onSuccess: onDone,
  })
  return (
    <>
      <Verb
        testId={`agent-trigger-toggle-${trigger.id}`}
        disabled={toggle.isPending}
        onClick={() => toggle.mutate()}
      >
        {trigger.enabled ? "Pause" : "Resume"}
      </Verb>
      <Button
        type="button"
        variant="destructive-ghost"
        size="xs"
        data-testid={`agent-trigger-remove-${trigger.id}`}
        onClick={() => setConfirming(true)}
      >
        Remove
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Remove this trigger?"
        description="The agent stops starting on it. Tasks it already started keep running."
        confirmLabel="Remove"
        confirmTestId={`agent-trigger-remove-confirm-${trigger.id}`}
        onConfirm={() => remove.mutateAsync()}
      />
    </>
  )
}

function ScheduleForm({
  agentId,
  trigger,
  instruction,
  setInstruction,
  manage,
  onDone,
}: FormProps) {
  const [cron, setCron] = useState(trigger?.cron ?? "0 9 * * 1-5")
  const [tz, setTz] = useState(trigger?.tz ?? BROWSER_TZ)
  const save = useApiMutation({
    mutationFn: () => {
      const body = { cron: cron.trim(), tz: tz.trim(), instruction: instruction.trim() }
      return trigger ? api.updateTrigger(trigger.id, body) : api.addTrigger(agentId, body)
    },
    invalidate: [["agents"]],
    onSuccess: (saved) => onDone(saved),
  })
  const ready = !!(cron.trim() && tz.trim() && instruction.trim())
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) save.mutate()
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={cron}
          onChange={(e) => setCron(e.target.value)}
          aria-label="Cron"
          data-testid="agent-schedule-cron"
          className="w-40 font-mono"
        />
        <Input
          value={tz}
          onChange={(e) => setTz(e.target.value)}
          aria-label="Time zone"
          data-testid="agent-schedule-tz"
          className="w-48"
        />
        {cron.trim() && cronLabel(cron) !== cron.trim() && (
          <span className="text-sm text-muted-foreground">{cronLabel(cron)}</span>
        )}
      </div>
      <InstructionBox value={instruction} onChange={setInstruction} />
      <FormActions
        ready={ready}
        saving={save.isPending}
        manage={manage}
        onCancel={() => onDone()}
      />
    </form>
  )
}

function GithubForm({
  sourceId,
  agentId,
  trigger,
  instruction,
  setInstruction,
  manage,
  onDone,
}: FormProps & { sourceId: string }) {
  const was = trigger?.on?.github
  // surface-ignore: suggestions only; without them the repository is typed instead.
  const repos = useQuery(githubRepositoriesQuery(sourceId, 1))
  const [repository, setRepository] = useState(was?.repository ?? "")
  const [event, setEvent] = useState<GithubEvent>(was?.event ?? "pull_request")
  const [actions, setActions] = useState<string[]>(
    was?.actions ?? ["opened", "synchronize", "ready_for_review"],
  )
  const [branches, setBranches] = useState((was?.branches ?? []).join(", "))
  const [drafts, setDrafts] = useState(was?.drafts ?? false)
  const [reviewers, setReviewers] = useState((was?.reviewers ?? []).join(", "))
  const spec = EVENTS[event]
  const names = repos.data?.repositories.map((r) => r.full_name) ?? []
  const save = useApiMutation({
    mutationFn: () => {
      const list = spec.branches
        ? branches
            .split(",")
            .map((b) => b.trim())
            .filter(Boolean)
        : []
      const logins = event === "pull_request" ? reviewers.split(/[\s,]+/).filter(Boolean) : []
      const on: GithubTriggerOn = {
        github: {
          event,
          repository: repository.trim(),
          ...(actions.length ? { actions } : {}),
          ...(list.length ? { branches: list } : {}),
          ...(logins.length ? { reviewers: logins } : {}),
          ...(drafts && (event === "pull_request" || event === "pull_request_review")
            ? { drafts: true }
            : {}),
        },
      }
      const body = { on, instruction: instruction.trim() }
      return trigger ? api.updateTrigger(trigger.id, body) : api.addTrigger(agentId, body)
    },
    invalidate: [["agents"]],
    onSuccess: (saved) => onDone(saved),
  })
  const ready = !!(/^[\w.-]+\/[\w.-]+$/.test(repository.trim()) && instruction.trim())
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) save.mutate()
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_11rem]">
        {names.length ? (
          <Select value={repository} onValueChange={setRepository}>
            <SelectTrigger data-testid="agent-trigger-repo" aria-label="Repository">
              <SelectValue placeholder="Repository" />
            </SelectTrigger>
            <SelectContent>
              {[...new Set([...(was ? [was.repository] : []), ...names])].map((n) => (
                <SelectItem key={n} value={n}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={repository}
            onChange={(e) => setRepository(e.target.value)}
            placeholder="owner/repository"
            aria-label="Repository"
            data-testid="agent-trigger-repo"
            className="font-mono"
          />
        )}
        <Select
          value={event}
          onValueChange={(v) => {
            const next = v as GithubEvent
            setEvent(next)
            setActions(EVENTS[next].actions.slice(0, 1).map((a) => a.value))
          }}
        >
          <SelectTrigger data-testid="agent-trigger-event" aria-label="Event">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(EVENTS) as GithubEvent[]).map((e) => (
              <SelectItem key={e} value={e}>
                {EVENTS[e].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {spec.actions.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm text-muted-foreground">When it’s</span>
          <ToggleGroup
            type="multiple"
            value={actions}
            onValueChange={setActions}
            data-testid="agent-trigger-actions"
            className="flex flex-wrap justify-start gap-1.5"
          >
            {spec.actions.map((a) => (
              <ToggleGroupItem
                key={a.value}
                value={a.value}
                data-testid={`agent-trigger-action-${a.value}`}
                className="group/chip h-7 gap-1 rounded-md border border-border px-2.5 text-sm text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:border-foreground/25 data-[state=on]:bg-card data-[state=on]:text-foreground"
              >
                <Check
                  aria-hidden="true"
                  className="-ml-0.5 hidden size-3 shrink-0 group-data-[state=on]/chip:block"
                />
                {a.chip ?? a.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {actions.length === 0 && <Sub>Nothing picked runs it on every {NOUN[event]}.</Sub>}
        </div>
      )}
      {spec.branches && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Input
            value={branches}
            onChange={(e) => setBranches(e.target.value)}
            placeholder={`${spec.branches}: all`}
            aria-label={spec.branches}
            data-testid="agent-trigger-branches"
            className="w-full font-mono sm:w-64"
          />
          {(event === "pull_request" || event === "pull_request_review") && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Switch
                checked={drafts}
                onCheckedChange={setDrafts}
                data-testid="agent-trigger-drafts"
              />
              Drafts too
            </label>
          )}
        </div>
      )}
      {event === "pull_request" && (
        <div className="flex flex-col gap-1.5">
          <Input
            value={reviewers}
            onChange={(e) => setReviewers(e.target.value)}
            placeholder="Reviewers: anyone"
            aria-label="Reviewers"
            data-testid="agent-trigger-reviewers"
            className="w-full font-mono sm:w-64"
          />
          {reviewers.trim() && actions.length > 0 && !actions.includes("review_requested") && (
            <Sub>Reviewers apply only to review requests.</Sub>
          )}
        </div>
      )}
      <InstructionBox value={instruction} onChange={setInstruction} />
      <Sub>
        Runs on the commit that started it, with the event’s details after your instruction.
      </Sub>
      <FormActions
        ready={ready}
        saving={save.isPending}
        manage={manage}
        onCancel={() => onDone()}
      />
    </form>
  )
}

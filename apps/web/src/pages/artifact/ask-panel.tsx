import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ArrowUp } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { type Agent, ApiError, api, type Job, type JobDetail } from "@/api"
import { Icon } from "@/components/icons"
import { LoadError } from "@/components/shared/load-error"
import { Spinner } from "@/components/shared/spinner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useAuth } from "@/ctx"
import { agentsQuery, artifactQuery, jobQuery, pageAsksQuery, workspaceQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useJobEvents } from "@/lib/use-job-events"
import { cn } from "@/lib/utils"
import { AnswerBox, useCanSteer, warningFor } from "@/pages/agents/agent-jobs"
import { machineOf, OPEN_STATUSES, rosterOf } from "@/pages/agents/format"
import { useMemberNames } from "@/pages/agents/use-member-names"
import { ActorGlyph } from "./activity-rows"
import { mdToHtml } from "./lib/markdown"

/** Mirrors the server's canAskAgent: anyone in the workspace, or for an invited-only agent,
 *  its creator and workspace owners. The server still decides. */
const canAsk = (a: Agent, meId: string, isOwner: boolean) =>
  !a.paused && (a.ask_policy === "workspace" || a.created_by === meId || isOwner)

/** The built-in Derive's agent id (DERIVE_AGENT_ID on the server). No agent row has it. */
const DERIVE = "derive"

/** One answerer the panel offers, and the line that says why it is offered. */
export type AskOption = { id: string; name: string; note: string }

/**
 * Who the page offers to ask, in order: the built-in Derive (it answers at once, when this
 * deploy has a model), then the agent that published this page while its machine is on, then the
 * agents that run on Derive's own machines. An agent on someone's laptop that is off, or that has
 * nothing to do with this page, would leave the question waiting, so it is not offered.
 *
 * The page reads this once: the top bar shows its Ask button when there is someone to ask, or
 * a conversation of yours about this page to come back to (its agent may since have paused),
 * and the panel's picker lists the same options.
 */
export function useAskOptions(shortId: string, publisherId: string | null, enabled: boolean) {
  const { me } = useAuth()
  const agents = useQuery({ ...agentsQuery(), enabled })
  const workspace = useQuery({ ...workspaceQuery(), enabled })
  const asks = useQuery({ ...pageAsksQuery(shortId), enabled })
  const names = useMemberNames()
  const isOwner = workspace.data?.role === "owner"
  const askable = rosterOf(agents.data ?? []).filter((a) => me && canAsk(a, me.id, isOwner))
  const publisher = askable.find((a) => a.id === publisherId)
  const all: AskOption[] = enabled
    ? [
        ...(workspace.data?.assistant ? [{ id: DERIVE, name: "Luna", note: "answers now" }] : []),
        ...(publisher && machineOf(publisher, names).on
          ? [{ id: publisher.id, name: publisher.name, note: "made this page · connected" }]
          : []),
        ...askable
          .filter((a) => a.machine === "derive")
          .map((a) => ({ id: a.id, name: a.name, note: "on a Derive machine" })),
      ]
    : []
  const options = all.filter((o, i) => all.findIndex((x) => x.id === o.id) === i)
  const returning = (asks.data?.length ?? 0) > 0
  return {
    options,
    available: options.length > 0 || returning,
    agentsError: agents.isError,
    retryAgents: () => void agents.refetch(),
  }
}

const WORD: Record<string, string> = {
  queued: "Waiting for its machine",
  running: "Working on it",
  needs_you: "Needs your answer",
  failed: "Failed",
  lost: "Its machine stopped answering",
  cancelled: "Cancelled",
}

/**
 * THE ASK PANEL: a private conversation about this page, beside the page's shared Activity
 * rather than inside it. A conversation is one job whose subject is the page; follow-ups are
 * more turns on that job. Opening the panel resumes the latest one you asked about this page
 * (the server lists them by subject); New starts a fresh one.
 */
export function AskPanel({
  shortId = "",
  selection,
  options,
  agentsError,
  onRetryAgents,
  currentVersion,
  onGoToVersion,
  onUndo,
  onClose,
}: {
  shortId?: string
  selection?: string
  options: AskOption[]
  agentsError: boolean
  onRetryAgents: () => void
  currentVersion: number
  onGoToVersion: (n: number) => void
  /** Restore this version as the newest (the page's own restore). Absent: this reader cannot
   *  publish here, so a version Derive made is linked but not undoable from the panel. */
  onUndo?: (n: number) => void
  /** Absent on a phone, where the sheet carries its own controls. */
  onClose?: () => void
}) {
  const { me } = useAuth()
  const client = useQueryClient()
  useJobEvents()
  const asks = useQuery<Job[]>(
    shortId
      ? pageAsksQuery(shortId)
      : {
          queryKey: ["jobs", "chats"],
          queryFn: () =>
            api
              .listJobs({ agent: DERIVE, limit: 100 })
              .then((r) => r.jobs.filter((j) => j.chat_context)),
          refetchOnMount: "always" as const,
        },
  )
  // undefined: resume the latest conversation; null: a fresh one (New); else that job.
  const [chosen, setChosen] = useState<string | null | undefined>(undefined)
  const latest = asks.data?.[0]?.id ?? null
  const followId = chosen === undefined ? latest : chosen
  const q = useQuery({
    ...jobQuery(followId ?? ""),
    enabled: !!followId,
    // A reload restores the persisted copy, which may be from before it settled: the events
    // only say what changes from here on, so read it fresh once on mount.
    refetchOnMount: "always",
    // The events say what changes from here on; the slow poll is only the fallback for a
    // stream that dropped.
    refetchIntervalInBackground: true,
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return !status || OPEN_STATUSES.includes(status) ? 3_000 : false
    },
  })
  const job = followId ? q.data : undefined
  const subject = job?.subject as { kind?: unknown; id?: unknown } | null | undefined
  const scopeId =
    subject?.kind === "artifact" && typeof subject.id === "string" ? subject.id : shortId
  const scope = useQuery({ ...artifactQuery(scopeId), enabled: !!scopeId })
  const landedVersion = job?.result?.effects
    ?.filter((e) => e.kind === "page" && e.ref === shortId)
    .at(-1)?.version
  useEffect(() => {
    if (shortId && landedVersion) void client.invalidateQueries({ queryKey: ["artifact", shortId] })
  }, [client, shortId, landedVersion])
  // A job that is gone (or in another workspace now) is let go, not retried.
  const gone = q.error instanceof ApiError && q.error.status === 404
  useEffect(() => {
    if (gone) setChosen(null)
  }, [gone])

  const agents = useQuery(agentsQuery())
  const [picked, setPicked] = useState<string | null>(null)
  const option = options.find((o) => o.id === picked) ?? options[0]
  const builtIn = job?.agent_id === DERIVE
  const jobAgent = builtIn ? "Luna" : agents.data?.find((a) => a.id === job?.agent_id)?.name
  const name = job ? (jobAgent ?? "Agent") : (option?.name ?? "Luna")
  // A reply continues the job you asked, unless it can no longer take one: then the next
  // message starts a new conversation with whoever the picker names.
  const continuing =
    !!job &&
    job.asked_by === me?.id &&
    !["cancelled", "lost", "needs_you"].includes(job.status) &&
    !(builtIn && job.status === "running")
  const waiting = !!job && builtIn && job.status === "running"
  // Only the built-in Derive's jobs are the asker's alone (it reads with their permissions);
  // any other agent's job is the workspace's to see, like the pages it publishes.
  const privateToMe = job ? builtIn : (option?.id ?? DERIVE) === DERIVE

  const stop = useApiMutation({
    mutationFn: (id: string) => api.cancelJob(id),
    invalidate: [["jobs"]],
  })
  const titleId = useId()
  const list = useRef<HTMLDivElement>(null)
  const count = job?.messages.length ?? 0
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on each new message.
  useEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [count, job?.status])

  return (
    <section
      data-testid="ask-panel"
      aria-labelledby={titleId}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex items-center gap-1 border-b border-border-soft py-1.5 pl-2.5 pr-2">
        <div className="flex min-w-0 flex-1 flex-col pl-1.5">
          <h2 id={titleId} data-testid="ask-panel-title" className="truncate text-sm font-medium">
            {shortId ? `Ask ${name}` : `Chat with ${name}`}
          </h2>
          <span
            data-testid="ask-panel-audience"
            className="flex items-center gap-1 text-2xs text-muted-foreground"
          >
            {privateToMe ? (
              <>
                <Icon name="lock" size={10} />
                Only you see this conversation
              </>
            ) : (
              "Your workspace can see this conversation"
            )}
          </span>
        </div>
        {(asks.data?.length ?? 0) > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="xs" data-testid="chat-history">
                History
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-80 max-w-xs overflow-auto">
              <DropdownMenuRadioGroup value={followId ?? ""} onValueChange={setChosen}>
                {asks.data?.map((j) => (
                  <DropdownMenuRadioItem key={j.id} value={j.id}>
                    <span className="truncate">{j.instruction.slice(0, 70)}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {waiting && (
          <Button
            variant="ghost"
            size="xs"
            data-testid="chat-stop"
            disabled={stop.isPending || job?.chat_context?.saving}
            onClick={() => job && stop.mutate(job.id)}
          >
            {job?.chat_context?.saving ? "Saving…" : "Stop"}
          </Button>
        )}
        <Button
          variant="ghost"
          size="xs"
          data-testid="ask-panel-new"
          disabled={!followId}
          onClick={() => setChosen(null)}
        >
          <Icon name="plus" />
          New
        </Button>
        {onClose && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Close Ask"
                data-testid="ask-panel-close"
                onClick={onClose}
              >
                <Icon name="close" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Close Ask</TooltipContent>
          </Tooltip>
        )}
      </div>

      <div
        data-testid="chat-scope"
        className="flex flex-col gap-1 border-b border-border-soft px-4 py-2 text-xs text-muted-foreground"
      >
        <span>
          Workspace access · Private chat ·{" "}
          {scopeId ? (
            <Link
              to="/artifacts/$ref"
              params={{ ref: scopeId }}
              className="underline underline-offset-2"
            >
              {scope.data?.title ?? "Artifact scope"} · v
              {job?.needs?.target_version ?? scope.data?.current_version ?? currentVersion}
            </Link>
          ) : (
            "Workspace scope"
          )}
        </span>
        {(job?.chat_context?.selection || (!job && selection)) && (
          <span className="line-clamp-2">
            Selection: “{job?.chat_context?.selection ?? selection}”
          </span>
        )}
        {job && !job.chat_context?.model_id && <span>Uses the workspace default model</span>}
        {job?.chat_context?.saving && job.status !== "running" && (
          <span role="alert">
            A save was interrupted. Check Activity and artifact versions before starting a new chat.
            This run cannot safely retry.
          </span>
        )}
      </div>
      <div ref={list} className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-3 py-3">
        {agentsError && (
          <LoadError
            layout="inline"
            title="Couldn’t load agents to ask."
            testId="ask-agents-retry"
            onRetry={onRetryAgents}
          />
        )}
        {followId && q.isError && !gone ? (
          <LoadError
            layout="inline"
            title="Couldn’t load this conversation."
            testId="ask-follow-retry"
            onRetry={() => void q.refetch()}
          />
        ) : job ? (
          <Conversation
            job={job}
            name={name}
            shortId={shortId}
            currentVersion={currentVersion}
            onGoToVersion={onGoToVersion}
            onUndo={onUndo}
          />
        ) : followId || (chosen === undefined && asks.isPending) ? (
          <Spinner size="sm" className="self-center" />
        ) : (
          <p className="text-sm text-muted-foreground">
            {shortId
              ? `Ask ${name} about this artifact.`
              : "Find an artifact, ask about your workspace, or create something new."}{" "}
            It reads what you can read.
          </p>
        )}
      </div>

      {/* Keyed on the conversation, so a draft never carries over into a different one. */}
      <AskComposer
        key={followId ?? "new"}
        shortId={shortId}
        selection={job?.chat_context?.selection ?? selection}
        currentVersion={currentVersion}
        options={continuing ? [] : options}
        option={option}
        onPick={setPicked}
        name={continuing ? name : (option?.name ?? name)}
        continueJob={continuing ? job?.id : undefined}
        disabled={waiting || job?.status === "needs_you" || (!continuing && !option)}
        onAsked={(id) => setChosen(id)}
        privateToMe={privateToMe}
        // A desktop opening (the top bar's Ask) puts the caret in the box; a phone's tab does
        // not, so the keyboard does not cover the sheet before anyone asked for it.
        focusOnOpen={!!onClose}
      />
    </section>
  )
}

/** The followed job's transcript: your messages on the right, the answers on the left. */
function Conversation({
  job,
  name,
  shortId,
  currentVersion,
  onGoToVersion,
  onUndo,
}: {
  job: JobDetail
  name: string
  shortId: string
  currentVersion: number
  onGoToVersion: (n: number) => void
  onUndo?: (n: number) => void
}) {
  const { me } = useAuth()
  const agents = useQuery(agentsQuery())
  const names = useMemberNames()
  const canSteer = useCanSteer(job, me?.id)
  const asked = agents.data?.find((a) => a.id === job.agent_id)
  // While it waits, say why it might keep waiting (paused, or its machine is off).
  const warning = job.status === "queued" && asked ? warningFor(asked, names) : null
  const open = OPEN_STATUSES.includes(job.status)
  const published = (job.result.effects ?? []).filter(
    (e): e is typeof e & { ref: string; version: number } =>
      e.kind === "page" && !!e.ref && typeof e.version === "number",
  )
  // Undo puts back the page as it was before this conversation first changed it, so a run
  // that published two versions is undone whole, not to its own first draft. Only while its
  // newest version is still the page's current one: a later publish by anyone is not undone.
  const here = published.filter((e) => e.ref === shortId).map((e) => e.version)
  const first = here.length ? Math.min(...here) : 0
  const last = here.length ? Math.max(...here) : 0
  return (
    <div data-testid="ask-job" data-status={job.status} className="flex flex-col gap-3">
      {job.messages.map((m) =>
        m.author_kind === "asker" ? (
          <p
            key={m.id}
            className="max-w-[85%] self-end rounded-lg bg-muted px-2.5 py-1.5 text-sm whitespace-pre-wrap"
          >
            {m.body_md}
          </p>
        ) : (
          <div key={m.id} className="flex items-start gap-2">
            <ActorGlyph by={name} agent />
            <p
              className={cn(
                "min-w-0 flex-1 text-sm whitespace-pre-wrap break-words [&_a]:underline [&_a]:underline-offset-2",
                m.progress ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {m.body_md.split(/(```[\s\S]*?```)/g).map((part, i) =>
                part.startsWith("```") ? (
                  <code
                    key={i}
                    className="my-2 block overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs"
                  >
                    {part.replace(/^```[^\n]*\n?/, "").replace(/```$/, "")}
                  </code>
                ) : (
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: mdToHtml escapes text and permits only HTTP or app-relative links.
                  <span key={i} dangerouslySetInnerHTML={{ __html: mdToHtml(part) }} />
                ),
              )}
              {m.model && (
                <span className="mt-1 block text-2xs text-muted-foreground">
                  {m.model.label}
                  {m.tools.length ? ` · ${m.tools.join(" → ")}` : ""}
                </span>
              )}
            </p>
          </div>
        ),
      )}
      {published.map((e) => (
        <div
          key={`${e.ref}@${e.version}`}
          data-testid="ask-published"
          className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-xs"
        >
          <Icon name="history" size={14} className="text-muted-foreground" />
          {e.ref === shortId ? (
            <button
              type="button"
              data-testid="ask-published-version"
              className="min-w-0 flex-1 truncate text-left hover:underline"
              onClick={() => onGoToVersion(e.version)}
            >
              <span className="font-mono tabular-nums">v{e.version}</span> published by {name}, for
              you
            </button>
          ) : (
            <Link
              to="/artifacts/$ref"
              params={{ ref: `${e.ref}@v${e.version}` }}
              data-testid="ask-published-page"
              className="min-w-0 flex-1 truncate hover:underline"
            >
              {e.label} published by {name}, for you
            </Link>
          )}
          {onUndo &&
            e.ref === shortId &&
            e.version === last &&
            last === currentVersion &&
            first > 1 && (
              <Button
                variant="ghost"
                size="xs"
                data-testid="ask-undo"
                onClick={() => onUndo(first - 1)}
              >
                Undo
              </Button>
            )}
        </div>
      ))}
      {open && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {job.status !== "needs_you" && <Spinner size="sm" role="presentation" />}
          {WORD[job.status]}
        </div>
      )}
      {!open && job.status !== "succeeded" && (
        <p className="text-xs text-muted-foreground">{WORD[job.status]}</p>
      )}
      {warning && (
        <p data-testid="ask-warning" className="text-xs text-warning">
          {warning}
        </p>
      )}
      {job.status === "needs_you" && canSteer && <AnswerBox job={job} />}
      {job.report_short_id && (
        <Link
          to="/artifacts/$ref"
          params={{ ref: job.report_short_id }}
          data-testid="ask-report"
          className="self-start text-xs font-medium hover:underline"
        >
          Report
        </Link>
      )}
    </div>
  )
}

/** The composer pinned at the bottom: a new question (to whoever the chip names), or the next
 *  message on the conversation it continues. */
function AskComposer({
  shortId,
  selection,
  currentVersion,
  options,
  option,
  onPick,
  name,
  continueJob,
  disabled,
  onAsked,
  privateToMe,
  focusOnOpen,
}: {
  shortId: string
  selection?: string | null
  currentVersion: number
  /** The picker's options; empty while continuing a conversation (its agent is fixed). */
  options: AskOption[]
  option: AskOption | undefined
  onPick: (id: string) => void
  name: string
  continueJob?: string
  disabled: boolean
  onAsked: (jobId: string) => void
  /** Derive's conversations are the asker's alone; another agent's job the workspace sees. */
  privateToMe: boolean
  focusOnOpen: boolean
}) {
  const [text, setText] = useState("")
  const [modelId, setModelId] = useState<string | null>(null)
  const models = useQuery({ queryKey: ["chat-models"], queryFn: api.chatModels })
  const field = useRef<HTMLTextAreaElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the panel opens.
  useEffect(() => {
    if (focusOnOpen) field.current?.focus()
  }, [])
  const send = useApiMutation({
    mutationFn: (body: string) =>
      continueJob
        ? api.writeJob(continueJob, body)
        : api.askAgent(
            option?.id ?? DERIVE,
            body,
            shortId ? { kind: "artifact", id: shortId } : undefined,
            {
              ...(shortId ? { base_version: currentVersion } : {}),
              ...(selection ? { selection } : {}),
              model_id: modelId,
            },
          ),
    invalidate: [["jobs"]],
    onSuccess: (job) => {
      setText("")
      if (!continueJob) onAsked(job.id)
    },
  })
  const submit = () => {
    if (text.trim() && !disabled && !send.isPending) send.mutate(text.trim())
  }
  return (
    <form
      className="flex shrink-0 flex-col gap-1.5 border-t border-border px-2.5 pt-2 pb-2.5"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <Textarea
        ref={field}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder={
          continueJob
            ? `Reply to ${name}…`
            : shortId
              ? "Ask about this artifact…"
              : "Find, ask, or create…"
        }
        aria-label={continueJob ? `Reply to ${name}` : `Ask ${name}`}
        data-testid="ask-input"
        className="field-sizing-content max-h-40 min-h-14"
      />
      <div className="flex items-center gap-2">
        {options.length > 1 && option ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="xs"
                data-testid="ask-agent"
                aria-label={`Asking ${option.name}`}
                className="text-muted-foreground"
              >
                {option.name}
                <Icon name="caret" size={12} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuRadioGroup value={option.id} onValueChange={onPick}>
                {options.map((o) => (
                  <DropdownMenuRadioItem key={o.id} value={o.id} data-testid={`ask-agent-${o.id}`}>
                    <span className="flex flex-col">
                      <span>{o.name}</span>
                      <span className="text-2xs text-muted-foreground">{o.note}</span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span className="pl-2 text-xs text-muted-foreground">{name}</span>
        )}
        {!continueJob && (option?.id ?? DERIVE) === DERIVE && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="xs" data-testid="chat-model">
                {models.data?.options.find((m) => m.id === modelId)?.label ?? "Default model"}
                <Icon name="caret" size={12} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuRadioGroup
                value={modelId ?? "default"}
                onValueChange={(id) => setModelId(id === "default" ? null : id)}
              >
                <DropdownMenuRadioItem value="default">Default model</DropdownMenuRadioItem>
                {models.data?.options.map((m) => (
                  <DropdownMenuRadioItem key={m.id} value={m.id}>
                    {m.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <span className="flex-1" />
        <Button
          type="submit"
          size="icon-xs"
          aria-label="Send"
          data-testid="ask-send"
          disabled={!text.trim() || disabled || send.isPending}
          loading={send.isPending}
        >
          <ArrowUp />
        </Button>
      </div>
      <p data-testid="ask-footnote" className="text-2xs text-muted-foreground">
        {privateToMe
          ? `Private to you. If ${name} changes an artifact, the new version shows in Activity.`
          : "Your team can see this job and its answer."}
      </p>
    </form>
  )
}

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ArrowUp } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { ApiError, api, type JobDetail } from "@/api"
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
import { artifactQuery, jobQuery, pageAsksQuery, workspaceQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useJobEvents } from "@/lib/use-job-events"
import { cn } from "@/lib/utils"
import { AnswerBox } from "@/pages/agents/agent-jobs"
import { OPEN_STATUSES } from "@/pages/agents/format"
import { mdToHtml } from "./lib/markdown"

/** Keep the existing built-in agent id for saved conversations. */
const DERIVE = "derive"

/** Offer Chat when a model is configured or a private conversation already exists. */
export function useChatAsk(shortId: string, enabled: boolean) {
  const workspace = useQuery({ ...workspaceQuery(), enabled })
  const asks = useQuery({ ...pageAsksQuery(shortId), enabled })
  return { available: enabled && (!!workspace.data?.assistant || !!asks.data?.length) }
}

const WORD: Record<string, string> = {
  queued: "Waiting",
  running: "Working on it",
  needs_you: "Needs your answer",
  failed: "Failed",
  lost: "The run was interrupted",
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
  currentVersion,
  onGoToVersion,
  onUndo,
  onClose,
}: {
  shortId?: string
  selection?: string
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
  const asks = useQuery({
    queryKey: shortId ? ["jobs", "chat", "page", shortId] : ["jobs", "chat", "chats"],
    queryFn: () =>
      shortId
        ? api.listJobs({ agent: DERIVE, subject: shortId, limit: 30 }).then((r) => r.jobs)
        : api
            .listJobs({ agent: DERIVE, limit: 100 })
            .then((r) => r.jobs.filter((j) => j.chat_context)),
    refetchOnMount: "always",
  })
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

  const workspace = useQuery({ ...workspaceQuery(), refetchOnMount: "always" })
  const name = "Chat"
  const continuing =
    !!job &&
    job.asked_by === me?.id &&
    !["cancelled", "lost", "needs_you", "running", "queued"].includes(job.status)
  const waiting = !!job && ["running", "queued"].includes(job.status)

  const stop = useApiMutation({
    mutationFn: (id: string) => api.cancelJob(id),
    invalidate: [["jobs"]],
  })
  const titleId = useId()
  const Heading = shortId ? "h2" : "h1"
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
      <div
        className={cn(
          "flex items-center gap-1 border-b border-border-soft py-1.5 pl-2.5 pr-2",
          !shortId && "px-3 py-3 sm:px-6 sm:py-4",
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col pl-1.5">
          <Heading
            id={titleId}
            data-testid="ask-panel-title"
            className={cn("truncate text-sm font-medium", !shortId && "sr-only sm:not-sr-only")}
          >
            Chat
          </Heading>
          <span
            data-testid="ask-panel-audience"
            className="flex items-center gap-1 text-2xs text-muted-foreground"
          >
            <Icon name="lock" size={10} />
            Private to you
          </span>
        </div>
        {(asks.data?.length ?? 0) > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="xs"
                className="min-h-11 sm:min-h-0"
                data-testid="chat-history"
              >
                History
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="max-h-80 max-w-[calc(100vw-2rem)] overflow-auto sm:max-w-xs"
            >
              <DropdownMenuRadioGroup value={followId ?? ""} onValueChange={setChosen}>
                {asks.data?.map((j) => (
                  <DropdownMenuRadioItem key={j.id} value={j.id} className="min-h-11 sm:min-h-0">
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
            className="min-h-11 sm:min-h-0"
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
          className="min-h-11 sm:min-h-0"
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

      {scopeId && (
        <div
          data-testid="chat-scope"
          className="flex flex-col gap-1 border-b border-border-soft px-4 py-2 text-xs text-muted-foreground"
        >
          <span>
            <Link
              to="/artifacts/$ref"
              params={{ ref: scopeId }}
              className="underline underline-offset-2"
            >
              {scope.data?.title ?? "Artifact scope"} · v
              {job?.needs?.target_version ?? scope.data?.current_version ?? currentVersion}
            </Link>
          </span>
          {(job?.chat_context?.selection || (!job && selection)) && (
            <span className="line-clamp-2">
              Selection: “{job?.chat_context?.selection ?? selection}”
            </span>
          )}
          {job && !job.chat_context?.model_id && <span>Uses the workspace default model</span>}
        </div>
      )}
      {job?.chat_context?.saving && job.status !== "running" && (
        <p role="alert" className="px-4 py-2 text-xs text-muted-foreground">
          A save was interrupted. Check Activity and artifact versions before starting a new chat.
          This run cannot safely retry.
        </p>
      )}
      <div ref={list} className="flex min-h-0 flex-1 flex-col overflow-auto">
        <div
          className={cn(
            "flex flex-1 flex-col gap-3 px-3 py-3",
            !shortId && "mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8",
          )}
        >
          {workspace.isError && (
            <LoadError
              layout="inline"
              title="Couldn’t load chat settings."
              testId="ask-settings-retry"
              onRetry={() => void workspace.refetch()}
            />
          )}
          {asks.isError && (
            <LoadError
              layout="inline"
              title="Couldn’t load chat history."
              testId="ask-history-retry"
              onRetry={() => void asks.refetch()}
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
            !asks.isError && (
              <div
                className={cn(
                  "text-sm text-muted-foreground",
                  !shortId && "flex flex-1 flex-col items-center justify-center gap-3 text-center",
                )}
              >
                {!shortId && <Icon name="comments" size={24} />}
                {!shortId && (
                  <h3 className="text-lg font-medium text-foreground">Start a conversation</h3>
                )}
                <p>
                  {shortId ? "Ask about this artifact." : "Ask about artifacts in this workspace."}
                </p>
              </div>
            )
          )}
        </div>
      </div>

      {!workspace.isPending && !workspace.isError && !workspace.data?.assistant && (
        <p role="status" className="px-4 py-2 text-xs text-muted-foreground">
          Chat is unavailable until a workspace model is configured.
        </p>
      )}
      {/* Keyed on the conversation, so a draft never carries over into a different one. */}
      <AskComposer
        key={followId ?? "new"}
        shortId={shortId}
        selection={job?.chat_context?.selection ?? selection}
        currentVersion={currentVersion}
        continueJob={continuing ? job?.id : undefined}
        disabled={
          waiting ||
          job?.status === "needs_you" ||
          !workspace.data?.assistant ||
          workspace.isError ||
          asks.isPending ||
          asks.isError ||
          (!!followId && !job)
        }
        onAsked={(job) => {
          client.setQueryData(jobQuery(job.id).queryKey, job)
          setChosen(job.id)
        }}
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
  const canSteer = job.asked_by === me?.id
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
            className="min-w-0 max-w-[85%] self-end break-words rounded-lg bg-muted px-2.5 py-1.5 text-sm whitespace-pre-wrap"
          >
            {m.body_md}
          </p>
        ) : (
          <div key={m.id} className="flex items-start gap-2">
            <Icon name="comments" size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
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
      {job.status === "needs_you" && canSteer && <AnswerBox job={job} />}
    </div>
  )
}

/** A new question or the next message in the current conversation. */
function AskComposer({
  shortId,
  selection,
  currentVersion,
  continueJob,
  disabled,
  onAsked,
  focusOnOpen,
}: {
  shortId: string
  selection?: string | null
  currentVersion: number
  continueJob?: string
  disabled: boolean
  onAsked: (job: JobDetail) => void
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
        : api.askAgent(DERIVE, body, shortId ? { kind: "artifact", id: shortId } : undefined, {
            ...(shortId ? { base_version: currentVersion } : {}),
            ...(selection ? { selection } : {}),
            model_id: modelId,
          }),
    invalidate: [["jobs"]],
    errorToast: false,
    paywall: false,
    onSuccess: (job) => {
      setText("")
      onAsked(job)
    },
  })
  const submit = () => {
    if (text.trim() && !disabled && !send.isPending) send.mutate(text.trim())
  }
  return (
    <form
      className={cn(
        "flex shrink-0 flex-col gap-1.5 border-t border-border px-2.5 pt-2 pb-2.5",
        !shortId &&
          "mx-auto mb-[max(0.75rem,env(safe-area-inset-bottom))] w-[calc(100%-1.5rem)] max-w-3xl rounded-xl border bg-card p-3 focus-within:border-ring sm:mb-6 sm:w-[calc(100%-3rem)]",
      )}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <Textarea
        ref={field}
        disabled={disabled || send.isPending}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder={shortId ? "Ask about this artifact…" : "Message…"}
        aria-label="Message Chat"
        data-testid="ask-input"
        className={cn(
          "field-sizing-content max-h-40 min-h-14 resize-none",
          !shortId &&
            "border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent",
        )}
      />
      <div className="flex items-center gap-2">
        {!continueJob && (models.data?.options.length ?? 0) > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="xs" data-testid="chat-model">
                {models.data?.options
                  .find((m) => m.id === (modelId ?? models.data.default_id))
                  ?.label?.replace(/^Luna$/, "Chat") ?? "Chat"}
                <Icon name="caret" size={12} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuRadioGroup
                value={modelId ?? "default"}
                onValueChange={(id) => setModelId(id === "default" ? null : id)}
              >
                <DropdownMenuRadioItem value="default">Workspace default</DropdownMenuRadioItem>
                {models.data?.options.map((m) => (
                  <DropdownMenuRadioItem key={m.id} value={m.id}>
                    {m.label === "Luna" ? "Chat" : m.label}
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
          className="size-11 sm:size-7"
          aria-label="Send"
          data-testid="ask-send"
          disabled={!text.trim() || disabled || send.isPending}
          loading={send.isPending}
        >
          <ArrowUp />
        </Button>
      </div>
      {send.error && (
        <p role="alert" data-testid="ask-send-error" className="text-xs text-destructive">
          {send.error.message}
        </p>
      )}
      {shortId && (
        <p data-testid="ask-footnote" className="text-2xs text-muted-foreground">
          Artifact changes appear in Activity.
        </p>
      )}
    </form>
  )
}

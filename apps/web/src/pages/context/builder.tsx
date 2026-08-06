import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useState } from "react"
import { ApiError, api } from "@/api"
import { ChatComposer } from "@/components/chat/chat-composer"
import { ChatThread } from "@/components/chat/chat-thread"
import { useChatSession } from "@/components/chat/use-chat-session"
import { Icon } from "@/components/icons"
import { PageShell } from "@/components/shared/page-shell"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/sonner"
import { agentsQuery, chatModelsQuery, contextsQuery, workspaceQuery } from "@/lib/queries"
import { useDocumentTitle } from "@/lib/use-document-title"
import { BUILDER_COPY } from "./builder-copy"
import { NewContextForm } from "./new-context-form"

// NEW CONTEXT — /contexts/new. TWO DOORS to the same outcome, and no jargon at either
// one: a guided conversation for everyone (this page's main act — Derive interviews you
// the way a new teammate would, and the transcript itself becomes the context, turn by
// turn, via ContextCard), and — for the one person who already has a manifest written,
// by hand or by their own agent — the raw name/short-id form one toggle away
// (new-context-form.tsx). That toggle is the only way into those fields: nowhere else in
// the app opens straight onto them.
//
// One-shot by design: this conversation is not meant to be revisited or picked back up
// from history (that is what the finished context's own console is for), so unlike the
// workspace chat page there is no model picker and no history dropdown — just ask, and
// the interview runs to a created context.
export function ContextBuilderPage() {
  useDocumentTitle(BUILDER_COPY.pageTitle)
  const qc = useQueryClient()

  // The workspace is this page's one hard dependency, same as the workspace chat: without
  // its id there is no conversation to open and no context to create it in.
  const {
    data: ws,
    isError: wsFailed,
    refetch: retryWs,
  } = useQuery({ ...workspaceQuery(), staleTime: 60_000 })
  const org = ws?.id ?? ""

  // Whether this DEPLOY has any model configured at all — one of two things that can make
  // the guided conversation itself unusable (chatArrival's `no_model` refusal). Checked
  // up front so the page never even offers a composer that can't work.
  const { data: modelsData, isError: modelsFailed } = useQuery(chatModelsQuery())
  // The other: a workspace-level refusal (chatBeta off, not a member — see chatGates in
  // routes/contexts.ts) can't be seen from the deploy-wide models list above, only from
  // actually trying to open. Every one of those refusals answers 404, so a 404 from THIS
  // call — and only this call, not a network blip or a 5xx — is treated as "this door
  // doesn't work here" rather than a transient send failure. over_budget/rate_limited/
  // no_model (503) stay on the ordinary chat.error path: they're real refusals, but not
  // reasons to hide the composer altogether.
  const [openRefused, setOpenRefused] = useState(false)
  const degraded =
    modelsFailed || (modelsData ? modelsData.models.length === 0 : false) || openRefused

  // A 403 is the OTHER refusal, and deliberately not a degraded flip: it means this person's
  // access here is read-only, so the conversation would work fine for a colleague — hiding it
  // and pushing the agent door would only send them at a second path that refuses for the same
  // reason. The server answers it with a sentence naming the fix (routes/contexts.ts), which
  // ApiError carries as its message, `useChatSession` puts on `chat.error`, and the composer
  // renders as its notice. So the whole handling of this case is: let it through.
  const open = useCallback(
    async (body: string) => {
      try {
        return await api.createBuilderSession({ workspace: org, body_md: body })
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) setOpenRefused(true)
        throw e
      }
    },
    [org],
  )
  // No custom follow-up: the builder carries no model choice to thread through a turn
  // (there is no picker), so the hook's default — POST /v1/sessions/{id}/messages with
  // just body_md — is already the exact call a bespoke closure here would write.
  const chat = useChatSession({ open, resetKey: org })

  // Agents load lazily for the expert form's picker; a 403 (non-admin) just hides it —
  // registering an existing manifest doesn't require admin, only naming an agent does.
  const { data: agents } = useQuery({ ...agentsQuery(), retry: false })
  const [showExpert, setShowExpert] = useState(false)

  if (wsFailed)
    return (
      <PageShell className="flex justify-center pt-16">
        <StatusPanel
          tone="danger"
          title={BUILDER_COPY.wsErrorTitle}
          description={BUILDER_COPY.wsErrorBody}
          action={
            <Button size="sm" onClick={() => void retryWs()} data-testid="builder-ws-retry">
              {BUILDER_COPY.retryButton}
            </Button>
          }
        />
      </PageShell>
    )

  const agentDoorCard = (
    <div
      className="flex flex-col gap-3 rounded-xl border bg-card p-3.5"
      data-testid="builder-agent-door"
    >
      <div className="flex items-center gap-2">
        <Icon name="sparkles" className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium text-foreground">{BUILDER_COPY.agentDoorTitle}</h2>
      </div>
      <p className="text-sm text-muted-foreground">{BUILDER_COPY.agentDoorBody}</p>
      <div className="flex items-start gap-2">
        <code className="block max-h-40 flex-1 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-secondary px-2.5 py-2 font-mono text-2xs text-foreground">
          {BUILDER_COPY.agentDoorPrompt}
        </code>
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          data-testid="builder-agent-door-copy"
          onClick={() => {
            navigator.clipboard?.writeText(BUILDER_COPY.agentDoorPrompt)
            toast.success("Prompt copied")
          }}
        >
          {BUILDER_COPY.copyButton}
        </Button>
      </div>
    </div>
  )

  return (
    <PageShell className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl font-medium tracking-tight text-foreground">
          {BUILDER_COPY.pageTitle}
        </h1>
        <p className="max-w-2xl text-pretty text-sm text-muted-foreground">{BUILDER_COPY.intro}</p>
      </div>

      {!degraded ? (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <div
            className="flex h-[min(30rem,60dvh)] min-h-64 min-w-0 flex-1 flex-col rounded-xl border"
            data-testid="builder-chat"
          >
            <ChatThread
              messages={chat.messages}
              working={chat.working}
              streaming={chat.streaming}
              onPoll={chat.poll}
              className="px-3 py-3"
              empty={
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                  <Icon name="sparkles" className="size-5 text-muted-foreground" />
                  <p className="max-w-sm text-sm text-muted-foreground">{BUILDER_COPY.intro}</p>
                </div>
              }
            />
            <ChatComposer
              onSend={chat.send}
              busy={chat.working}
              disabled={!org || chat.working}
              notice={chat.error ?? undefined}
              placeholder={BUILDER_COPY.composerPlaceholder}
            />
          </div>
          <div className="lg:w-80 lg:shrink-0">{agentDoorCard}</div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground" data-testid="builder-degraded-notice">
            {BUILDER_COPY.degradedNotice}
          </p>
          {agentDoorCard}
        </div>
      )}

      <div className="flex flex-col gap-3 border-t border-border-soft pt-4">
        <button
          type="button"
          data-testid="builder-expert-door"
          onClick={() => setShowExpert((v) => !v)}
          className="self-start text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {BUILDER_COPY.expertDoor}
        </button>
        {showExpert && (
          <NewContextForm
            agents={(agents ?? [])
              .filter((a) => !a.managed)
              .map((a) => ({ id: a.id, name: a.name }))}
            onCreated={() => qc.invalidateQueries({ queryKey: contextsQuery().queryKey })}
          />
        )}
      </div>
    </PageShell>
  )
}

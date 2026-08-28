import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useState } from "react"
import { ApiError, api } from "@/api"
import { ChatComposer } from "@/components/chat/chat-composer"
import { ChatThread } from "@/components/chat/chat-thread"
import { useChatSession } from "@/components/chat/use-chat-session"
import { Icon } from "@/components/icons"
import { PageShell } from "@/components/shared/page-shell"
import { SectionTitle } from "@/components/shared/section-title"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { copyText } from "@/lib/clipboard"
import { agentsQuery, chatModelsQuery, contextsQuery, workspaceQuery } from "@/lib/queries"
import { useDocumentTitle } from "@/lib/use-document-title"
import { BUILDER_COPY } from "./builder-copy"
import { NewContextForm } from "./new-context-form"

function AgentDoor() {
  const copy = () => void copyText(BUILDER_COPY.agentDoorPrompt, { success: "Prompt copied" })

  return (
    <div
      className="flex flex-col gap-3 rounded-xl border bg-card p-3.5"
      data-testid="builder-agent-door"
    >
      <div className="flex items-center gap-2">
        <Icon name="sparkles" className="size-4 text-muted-foreground" />
        <SectionTitle as="h2" className="min-w-0 flex-1">
          {BUILDER_COPY.agentDoorTitle}
        </SectionTitle>
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
          onClick={copy}
        >
          {BUILDER_COPY.copyButton}
        </Button>
      </div>
    </div>
  )
}

export function AgentBuilderPage() {
  useDocumentTitle(BUILDER_COPY.pageTitle)
  const qc = useQueryClient()
  const [showExpert, setShowExpert] = useState(false)
  const [openRefused, setOpenRefused] = useState(false)
  const {
    data: workspace,
    isError: workspaceFailed,
    refetch: retryWorkspace,
  } = useQuery({ ...workspaceQuery(), staleTime: 60_000 })
  const org = workspace?.id ?? ""
  const models = useQuery(chatModelsQuery())
  const degraded = models.isError || models.data?.models.length === 0 || openRefused

  const open = useCallback(
    async (body: string) => {
      try {
        return await api.createChatSession({
          workspace: org,
          body_md: body,
          purpose: "context_builder",
        })
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) setOpenRefused(true)
        throw error
      }
    },
    [org],
  )
  const chat = useChatSession({ open, resetKey: org })
  const { data: agents } = useQuery({
    ...agentsQuery(),
    enabled: showExpert,
    retry: false,
  })

  if (workspaceFailed)
    return (
      <PageShell className="flex justify-center pt-16">
        <StatusPanel
          tone="danger"
          title={BUILDER_COPY.wsErrorTitle}
          description={BUILDER_COPY.wsErrorBody}
          action={
            <Button size="sm" onClick={() => void retryWorkspace()} data-testid="builder-ws-retry">
              {BUILDER_COPY.retryButton}
            </Button>
          }
        />
      </PageShell>
    )

  return (
    <PageShell className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl font-medium tracking-tight text-foreground">
          {BUILDER_COPY.pageTitle}
        </h1>
        <p className="max-w-2xl text-pretty text-sm text-muted-foreground">{BUILDER_COPY.intro}</p>
      </div>

      {degraded ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground" data-testid="builder-degraded-notice">
            {BUILDER_COPY.degradedNotice}
          </p>
          <AgentDoor />
        </div>
      ) : (
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
          <div className="lg:w-80 lg:shrink-0">
            <AgentDoor />
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <button
          type="button"
          data-testid="builder-expert-door"
          onClick={() => setShowExpert((shown) => !shown)}
          className="self-start text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {BUILDER_COPY.expertDoor}
        </button>
        {showExpert && (
          <NewContextForm
            agents={(agents ?? [])
              .filter((agent) => !agent.managed)
              .map(({ id, name }) => ({ id, name }))}
            onCreated={() => void qc.invalidateQueries({ queryKey: contextsQuery().queryKey })}
          />
        )}
      </div>
    </PageShell>
  )
}

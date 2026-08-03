import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/api"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { chatModelsQuery, operatorQuery, workspaceSettingsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { cn } from "@/lib/utils"
import { SettingsSection } from "./settings-section"

// WHICH MODEL ANSWERS, changeable while people are typing.
//
// The deploy's default lives in configuration, so changing it needs a redeploy — the wrong shape
// for the moment it is most needed in, which is a provider that has gone slow or dark mid-day.
// This is the same choice held where an admin can change it in seconds; the turn re-reads it, so
// the next message uses the new one, including in conversations already open.
//
// It renders only where there is a choice to make (see Settings): one configured model is a fact
// about the deploy, not a decision, and a picker with a single row would imply otherwise.

export function ModelsSection() {
  const qc = useQueryClient()
  const { data, isError, refetch } = useQuery(chatModelsQuery())
  const { data: settings } = useQuery(workspaceSettingsQuery())
  // INSTANCE operator, not workspace Admin. Which provider answers is the operator's call —
  // they hold the credential and pay for it — and a workspace Admin changing it would be
  // spending somebody else's key. The query 403s for everyone else, which is the signal.
  const { isSuccess: isOperator } = useQuery(operatorQuery())
  const models = data?.models ?? []
  const override = settings?.chatModel ?? null
  const deployDefault = models.find((m) => m.is_default)

  const pick = useApiMutation({
    // null clears the override and hands the choice back to the deploy default.
    mutationFn: (chatModel: string | null) => api.updateWorkspaceSettings({ chatModel }),
    success: (_d, chatModel) =>
      chatModel ? "Chat will answer with the model you picked" : "Back to the deploy default",
    onSuccess: () => qc.invalidateQueries({ queryKey: workspaceSettingsQuery().queryKey }),
  })

  return (
    <SettingsSection
      title="Chat model"
      description="Which model answers chat in this workspace. It takes effect on the next message — including in conversations that are already open — so it is the switch to reach for when a provider is slow or down."
    >
      {/* Without the catalog there is nothing to choose BETWEEN, and guessing at it would offer
          a switch that cannot be trusted — say so and let them retry. */}
      {isError ? (
        <StatusPanel
          tone="danger"
          title="Couldn't load the models"
          description="The list of models this deploy can answer with didn't load, so there is nothing to choose between."
          action={
            <Button size="sm" onClick={() => void refetch()} data-testid="chat-models-retry">
              Try again
            </Button>
          }
        />
      ) : (
        <SettingsGroup>
          <Row
            label="Use the deploy default"
            hint={deployDefault ? `Currently ${deployDefault.label}` : undefined}
            selected={!override}
            busy={pick.isPending || !isOperator}
            onSelect={() => pick.mutate(null)}
            testId="chat-model-default"
          />
          {models.map((m) => (
            <Row
              key={m.id}
              label={m.label}
              hint={m.id}
              selected={override === m.id}
              busy={pick.isPending || !isOperator}
              onSelect={() => pick.mutate(m.id)}
              testId={`chat-model-${m.id}`}
            />
          ))}
        </SettingsGroup>
      )}
    </SettingsSection>
  )
}

function Row({
  label,
  hint,
  selected,
  busy,
  onSelect,
  testId,
}: {
  label: string
  hint?: string
  selected: boolean
  busy: boolean
  onSelect: () => void
  testId: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">
          {label}
          {selected && (
            <Badge variant="secondary" shape="pill" className="ml-2">
              In use
            </Badge>
          )}
        </div>
        {hint && (
          // The id, in the register ids are written in everywhere else here — it is what a
          // transcript records and what an operator types into configuration.
          <div className="truncate font-mono text-2xs text-muted-foreground">{hint}</div>
        )}
      </div>
      <Button
        size="sm"
        variant={selected ? "secondary" : "outline"}
        disabled={busy || selected}
        onClick={onSelect}
        data-testid={testId}
        className={cn(selected && "pointer-events-none")}
      >
        {selected ? "Selected" : "Use this"}
      </Button>
    </div>
  )
}

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/api"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { instanceChatModelQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { cn } from "@/lib/utils"
import { SettingsSection } from "./settings-section"

// WHICH MODEL ANSWERS, for the whole deployment, changeable while people are typing.
//
// An OPERATOR control, not a workspace one: the operator holds the model credential and pays for
// every turn on it, so a workspace Admin changing it would be spending somebody else's key — and
// when a provider goes slow or dark, the person who has to move everyone at once is the one who
// runs the instance.
//
// The configured default lives in the deployment's environment and therefore needs a redeploy,
// which is the wrong shape for exactly that moment. This is the same choice held where it can be
// changed in seconds; the turn re-reads it, so the next message uses the new one — including in
// conversations that are already open.

export function ModelsSection() {
  const qc = useQueryClient()
  // Operator-only. A 403 here means "not an operator", which is why the section is not offered to
  // anyone else in the first place (see Settings) — this state is for a genuine load failure.
  const { data, isError, refetch } = useQuery(instanceChatModelQuery())
  const models = data?.options ?? []
  const override = data?.model ?? null
  const configured = models.find((m) => m.is_default)

  const pick = useApiMutation({
    // null hands the choice back to whatever the deployment is configured with.
    mutationFn: (model: string | null) => api.setInstanceChatModel(model),
    success: (_d, model) =>
      model ? "Chat answers with that model now, everywhere" : "Back to the configured default",
    onSuccess: () => qc.invalidateQueries({ queryKey: instanceChatModelQuery().queryKey }),
  })

  return (
    <SettingsSection
      title="Chat model"
      description="Which model answers chat across this whole deployment. It takes effect on the next message — including in conversations that are already open — so it is the switch to reach for when a provider is slow or down."
    >
      {/* Without the catalog there is nothing to choose BETWEEN, and guessing at it would offer a
          switch that cannot be trusted — say so and let them retry. */}
      {isError ? (
        <StatusPanel
          tone="danger"
          title="Couldn't load the models"
          description="The list of models this deployment can answer with didn't load, so there is nothing to choose between."
          action={
            <Button size="sm" onClick={() => void refetch()} data-testid="chat-models-retry">
              Try again
            </Button>
          }
        />
      ) : (
        <SettingsGroup>
          <Row
            label="Use the configured default"
            hint={configured ? `Currently ${configured.label}` : undefined}
            selected={!override}
            busy={pick.isPending}
            onSelect={() => pick.mutate(null)}
            testId="chat-model-default"
          />
          {models.map((m) => (
            <Row
              key={m.id}
              label={m.label}
              hint={m.id}
              selected={override === m.id}
              busy={pick.isPending}
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

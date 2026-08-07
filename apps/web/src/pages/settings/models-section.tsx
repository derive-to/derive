import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api, type ModelLibraryEntry, type ModelObservedView, type ModelProbeView } from "@/api"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { modelLibraryQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { cn } from "@/lib/utils"
import { SettingsSection } from "./settings-section"

// THE MODEL LIBRARY — which models this deployment can answer with, which one serves which lane,
// and how each is actually performing. An OPERATOR surface, not a workspace one: the operator
// holds the model credential and pays for every turn on it, so a workspace Admin changing this
// would be spending somebody else's key — and when a provider goes slow or dark, the person who
// has to move everyone at once is the one who runs the instance.
//
// The whole page exists for one moment: a provider has gone bad and people are typing. So it
// answers the three questions of that moment in one view — what is running, what else could run,
// and which of them is fast — rather than making somebody assemble it from three screens. Adding
// a model and pinning a lane both take effect on the NEXT turn, including in conversations that
// are already open; neither needs a deploy.

/** ms → the shortest honest reading. Sub-second latency is the difference between a chat that
 *  feels live and one that does not, so it keeps a decimal where a whole number would round that
 *  distinction away. */
const ms = (v: number | null | undefined): string | null =>
  v === null || v === undefined
    ? null
    : v < 1000
      ? `${Math.round(v)}ms`
      : `${(v / 1000).toFixed(1)}s`

/** Coarse and unitless on purpose: an operator comparing models needs "when", not a timestamp to
 *  parse. */
const ago = (iso: string | null | undefined): string | null => {
  if (!iso) return null
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (!Number.isFinite(mins)) return null
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / (60 * 24))}d ago`
}

export function ModelsSection() {
  const qc = useQueryClient()
  // Operator-only. A 403 here means "not an operator", which is why the section is not offered
  // to anyone else in the first place (see Settings) — this state is for a genuine load failure.
  const { data, isError, refetch } = useQuery(modelLibraryQuery())
  const models = data?.models ?? []
  const slots = data?.slots ?? { chat: null, automation: null }
  const configured = models.find((m) => m.is_default)
  const [newId, setNewId] = useState("")
  const [probing, setProbing] = useState<string | null>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: modelLibraryQuery().queryKey })

  const pin = useApiMutation({
    mutationFn: ({ lane, model }: { lane: "chat" | "automation"; model: string | null }) =>
      api.setModelSlot(lane, model),
    success: (_d, v) =>
      v.model
        ? v.lane === "chat"
          ? "Chat answers with that model now, everywhere"
          : "Automations run on that model now"
        : "Back to the configured default",
    onSuccess: invalidate,
  })

  const add = useApiMutation({
    mutationFn: (id: string) => api.addModel(id),
    // The probe runs before it is saved, so this message is a measurement rather than a promise.
    success: (d) => `Added ${d.id} — answered in ${ms(d.probe.total_ms) ?? "no time at all"}`,
    onSuccess: () => {
      setNewId("")
      invalidate()
    },
  })

  const remove = useApiMutation({
    mutationFn: (id: string) => api.removeModel(id),
    success: (_d, id) => `Removed ${id}`,
    onSuccess: invalidate,
  })

  // Probing reports a FINDING, so a model that failed is a successful probe with bad news — the
  // toast says what was learned rather than treating a slow provider as a broken button.
  const probe = useApiMutation({
    mutationFn: (id: string) => api.probeModel(id),
    success: (d) =>
      d.probe.ok
        ? `${d.id} answered in ${ms(d.probe.total_ms) ?? "no time at all"}`
        : `${d.id} did not answer: ${d.probe.error ?? "no reply"}`,
    onSuccess: () => {
      setProbing(null)
      invalidate()
    },
    onError: () => setProbing(null),
  })

  const runProbe = (id: string) => {
    setProbing(id)
    probe.mutate(id)
  }

  return (
    <SettingsSection
      title="Models"
      description="Which models this deployment can answer with, and which one serves each lane. Changes take effect on the next turn, including in conversations that are already open, so this is the switch to reach for when a provider is slow or down."
      actions={
        models.length > 0 ? (
          <Button
            size="sm"
            variant="outline"
            disabled={probe.isPending}
            onClick={() => {
              // Sequential, not concurrent: several models behind one gateway share its rate
              // limit, and a burst measures the queue rather than the models.
              const run = async () => {
                for (const m of models) {
                  setProbing(m.id)
                  await api.probeModel(m.id).catch(() => undefined)
                }
                setProbing(null)
                invalidate()
              }
              void run()
            }}
            data-testid="probe-all-models"
          >
            Probe all
          </Button>
        ) : undefined
      }
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
        <>
          <SettingsGroup
            title="Lanes"
            description="Chat is attended, so somebody is waiting on the first token. Automations run unattended, where depth is worth more than turnaround. Pinning a lane names the model, never who pays for it."
          >
            <Lane
              label="Chat"
              hint="The document rail, workspace chat, @derive in a comment, and @Derive in Slack."
              current={slots.chat}
              fallback={configured?.label}
              models={models}
              busy={pin.isPending}
              onPick={(model) => pin.mutate({ lane: "chat", model })}
              testId="slot-chat"
            />
            <Lane
              label="Automations"
              hint="Unattended runs on this deploy's own gateway. Runs that bill a connected plan keep their own model."
              current={slots.automation}
              fallback={configured?.label}
              models={models}
              busy={pin.isPending}
              onPick={(model) => pin.mutate({ lane: "automation", model })}
              testId="slot-automation"
            />
          </SettingsGroup>

          <SettingsGroup
            title="Library"
            description={
              data?.can_add
                ? "Models on the gateway this deployment is already configured with. Adding one needs no new key and no deploy; a different provider needs a key, which only the environment can hold."
                : "This deployment has no model gateway configured, so models come from its environment and cannot be added here."
            }
          >
            {models.map((m) => (
              <Row
                key={m.id}
                model={m}
                pinnedTo={[
                  slots.chat === m.id ? "Chat" : null,
                  slots.automation === m.id ? "Automations" : null,
                ].filter(Boolean as unknown as (v: string | null) => v is string)}
                probing={probing === m.id}
                busy={probe.isPending || remove.isPending}
                onProbe={() => runProbe(m.id)}
                onRemove={() => remove.mutate(m.id)}
              />
            ))}
            {data?.can_add && (
              <form
                className="flex flex-wrap items-center gap-2 py-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  const id = newId.trim()
                  if (id) add.mutate(id)
                }}
              >
                <Input
                  value={newId}
                  onChange={(e) => setNewId(e.target.value)}
                  // The provider's own id, because that is what it answers to and what a
                  // transcript records. A friendly name here would be a name for nothing.
                  placeholder="Model id, exactly as the provider names it"
                  className="min-w-56 flex-1 font-mono text-xs"
                  data-testid="add-model-id"
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={!newId.trim() || add.isPending}
                  data-testid="add-model"
                >
                  {/* It is probed before it is saved, so the wait is a real call to the provider
                      and saying "Add" alone would under-describe what is happening. */}
                  {add.isPending ? "Probing…" : "Add and probe"}
                </Button>
              </form>
            )}
          </SettingsGroup>
        </>
      )}
    </SettingsSection>
  )
}

/** One lane and what serves it. The configured default is always an option, so a lane can always
 *  be handed back rather than only re-pointed. */
function Lane({
  label,
  hint,
  current,
  fallback,
  models,
  busy,
  onPick,
  testId,
}: {
  label: string
  hint: string
  current: string | null
  fallback?: string
  models: ModelLibraryEntry[]
  busy: boolean
  onPick: (model: string | null) => void
  testId: string
}) {
  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="text-sm font-medium text-foreground">{label}</div>
      <div className="text-xs text-muted-foreground">{hint}</div>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          size="sm"
          variant={current ? "outline" : "secondary"}
          disabled={busy || !current}
          onClick={() => onPick(null)}
          data-testid={`${testId}-default`}
          className={cn(!current && "pointer-events-none")}
        >
          {fallback ? `Configured default (${fallback})` : "Configured default"}
        </Button>
        {models.map((m) => (
          <Button
            key={m.id}
            size="sm"
            variant={current === m.id ? "secondary" : "outline"}
            disabled={busy || current === m.id}
            onClick={() => onPick(m.id)}
            data-testid={`${testId}-${m.id}`}
            className={cn(current === m.id && "pointer-events-none")}
          >
            {m.label}
          </Button>
        ))}
      </div>
    </div>
  )
}

function Row({
  model,
  pinnedTo,
  probing,
  busy,
  onProbe,
  onRemove,
}: {
  model: ModelLibraryEntry
  pinnedTo: string[]
  probing: boolean
  busy: boolean
  onProbe: () => void
  onRemove: () => void
}) {
  return (
    <div className="flex flex-wrap items-start gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">
          {model.label}
          {model.is_default && (
            <Badge variant="secondary" shape="pill" className="ml-2">
              Default
            </Badge>
          )}
          {pinnedTo.map((lane) => (
            <Badge key={lane} variant="secondary" shape="pill" className="ml-2">
              {lane}
            </Badge>
          ))}
        </div>
        {/* The id, in the register ids are written in everywhere else here — it is what a
            transcript records and what an operator types into configuration. */}
        <div className="truncate font-mono text-2xs text-muted-foreground">{model.id}</div>
        <Timings probe={model.probe} observed={model.observed} probing={probing} />
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={onProbe}
          data-testid={`probe-model-${model.id}`}
        >
          {probing ? "Probing…" : "Probe"}
        </Button>
        {/* Only a library entry. A configured id belongs to the environment, and taking the last
            reachable model off a running deploy through a settings write is not a lever. */}
        {model.removable && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={onRemove}
            data-testid={`remove-model-${model.id}`}
          >
            Remove
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * Two numbers, from two sources, kept apart because they answer different questions.
 *
 * OBSERVED is what people are actually waiting for — the median and tail of real turns. It is the
 * better number and it is shown first, but it does not exist for a model nobody has used yet,
 * which is every model the moment it is added.
 *
 * PROBED is one synthetic call. Comparable across models because it is always the same prompt,
 * available immediately, and the only thing that can answer for a model with no traffic.
 */
function Timings({
  probe,
  observed,
  probing,
}: {
  probe: ModelProbeView | null
  observed: ModelObservedView | null
  probing: boolean
}) {
  if (probing) return <div className="pt-1 text-xs text-muted-foreground">Probing…</div>
  const parts: string[] = []
  if (observed) {
    const p50 = ms(observed.total_p50_ms)
    const ttft = ms(observed.ttft_p50_ms)
    if (p50)
      parts.push(
        `${ttft ? `${ttft} to first token · ` : ""}${p50} median over ${observed.samples} turn${
          observed.samples === 1 ? "" : "s"
        }`,
      )
  }
  if (probe) {
    const when = ago(probe.at)
    parts.push(
      probe.ok
        ? `probe ${ms(probe.total_ms) ?? "—"}${when ? ` ${when}` : ""}`
        : `probe failed${when ? ` ${when}` : ""}`,
    )
  }
  if (!parts.length)
    return <div className="pt-1 text-xs text-muted-foreground">No timings yet — probe it.</div>
  return (
    <div className="flex flex-col gap-0.5 pt-1">
      <div className="text-xs text-muted-foreground">{parts.join(" · ")}</div>
      {/* The provider's own words. An operator debugging a 401 has to be able to read it. */}
      {probe && !probe.ok && probe.error && (
        <div className="truncate font-mono text-2xs text-destructive">{probe.error}</div>
      )}
    </div>
  )
}

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api, type Webhook } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { fieldError } from "@/components/shared/field-error"
import { ListRow } from "@/components/shared/list-row"
import { LoadError } from "@/components/shared/load-error"
import { SettingsEmpty } from "@/components/shared/settings-empty"
import { SettingsGroup } from "@/components/shared/settings-group"
import { Spinner } from "@/components/shared/spinner"
import { StatusBadge, type StatusTone } from "@/components/shared/status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { webhookDeliveriesQuery, webhooksQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { AddForm } from "./add-form"
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SettingsSection } from "./settings-section"

export function WebhooksSection() {
  const qc = useQueryClient()
  const { data, isPending, isError, refetch } = useQuery(webhooksQuery())
  const hooks = data?.webhooks
  const reload = () => qc.invalidateQueries({ queryKey: webhooksQuery().queryKey })

  return (
    <SettingsSection
      title="Webhooks"
      description={
        <>
          Get a POST — or a Slack message — when comments change or a new version is published.
          Payloads are signed (
          <a
            href="https://www.standardwebhooks.com"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            Standard Webhooks
          </a>
          ).
        </>
      }
    >
      <NewWebhook eventOptions={data?.event_options ?? []} onCreated={reload} />

      {isPending ? (
        <SettingsListSkeleton />
      ) : isError ? (
        <LoadError
          title="Couldn’t load webhooks"
          testId="webhooks-retry"
          onRetry={() => refetch()}
        />
      ) : !hooks || hooks.length === 0 ? (
        <SettingsEmpty>No webhooks yet — nothing is being sent anywhere.</SettingsEmpty>
      ) : (
        <SettingsGroup>
          {hooks.map((w) => (
            <WebhookRow key={w.id} hook={w} onDone={reload} />
          ))}
        </SettingsGroup>
      )}
    </SettingsSection>
  )
}

function NewWebhook({
  eventOptions,
  onCreated,
}: {
  eventOptions: string[]
  onCreated: () => void
}) {
  const [url, setUrl] = useState("")
  const [kind, setKind] = useState<"generic" | "slack">("generic")
  // Everything ticked by default, and "everything ticked" is what sends no filter at all.
  const [events, setEvents] = useState<string[] | null>(null)
  const [filtering, setFiltering] = useState(false)
  const selected = events ?? eventOptions
  const valid = /^https?:\/\//.test(url)
  const urlField = fieldError(
    "webhook-url-error",
    url.trim() && !valid ? "Enter a full https:// URL." : null,
  )
  const toggle = (e: string) =>
    setEvents((cur) => {
      const now = cur ?? eventOptions
      return now.includes(e) ? now.filter((x) => x !== e) : [...now, e]
    })
  const create = useApiMutation({
    mutationFn: () =>
      api.createWebhook({
        url,
        kind,
        events: selected.length === eventOptions.length ? undefined : selected,
      }),
    success: "Webhook added",
    onSuccess: () => {
      setUrl("")
      setEvents(null)
      setFiltering(false)
      onCreated()
    },
  })
  const add = () => {
    if (valid) create.mutate()
  }
  return (
    <AddForm
      onSubmit={add}
      submitLabel="Add"
      submitTestId="webhook-add"
      pending={create.isPending}
      disabled={!valid}
      after={
        <>
          {urlField.node}
          {/* The default is every event, which stores no filter — so the checkbox
              wall carries no information until someone wants to narrow it. Keep it
              behind a quiet disclosure; surface it automatically once narrowed. */}
          {!filtering && events === null ? (
            <Button
              type="button"
              data-testid="webhook-filter-events"
              variant="link"
              size="sm"
              className="self-start px-0 text-muted-foreground"
              onClick={() => setFiltering(true)}
            >
              Sends every event — filter…
            </Button>
          ) : (
            <div className="flex flex-wrap gap-3.5">
              {eventOptions.map((e) => (
                <label
                  key={e}
                  className="flex items-center gap-1.5 font-mono text-2xs text-muted-foreground"
                >
                  <Checkbox
                    data-testid={`webhook-event-${e}`}
                    checked={selected.includes(e)}
                    onCheckedChange={() => toggle(e)}
                  />
                  {e}
                </label>
              ))}
            </div>
          )}
        </>
      }
    >
      <Select value={kind} onValueChange={(v) => setKind(v as "generic" | "slack")}>
        <SelectTrigger data-testid="webhook-kind" aria-label="Webhook type" className="w-27.5">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="generic">Webhook</SelectItem>
          <SelectItem value="slack">Slack</SelectItem>
        </SelectContent>
      </Select>
      <Input
        data-testid="webhook-url"
        aria-label="Endpoint URL"
        {...urlField.aria}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder={
          kind === "slack" ? "Slack incoming-webhook URL" : "https://your-endpoint.example.com/hook"
        }
        className="min-w-60 flex-1"
      />
    </AddForm>
  )
}

// Delivery outcome → tone: delivered is a quiet success, dead means the server
// gave up retrying, anything in flight (pending/retrying) stays muted.
const deliveryTone = (status: string): StatusTone =>
  status === "delivered" ? "ok" : status === "dead" ? "error" : "muted"

function WebhookRow({ hook, onDone }: { hook: Webhook; onDone: () => void }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  // Lazily load this webhook's delivery log only while the row's log is open.
  const { data: deliveries, isPending } = useQuery({
    ...webhookDeliveriesQuery(hook.id),
    enabled: open,
  })
  const showLog = () => setOpen((o) => !o)
  const test = useApiMutation({
    mutationFn: () => api.testWebhook(hook.id),
    success: "Test event queued",
    onSuccess: () => {
      // Refresh the delivery log (if open) once the queued event has had a moment to land.
      if (open)
        setTimeout(
          () => qc.invalidateQueries({ queryKey: webhookDeliveriesQuery(hook.id).queryKey }),
          1500,
        )
    },
  })
  const [confirming, setConfirming] = useState(false)
  const remove = useApiMutation({
    mutationFn: () => api.deleteWebhook(hook.id),
    success: "Webhook removed",
    onSuccess: () => onDone(),
  })
  return (
    <ListRow
      data-testid={`webhook-row-${hook.id}`}
      leading={<Badge>{hook.kind === "slack" ? "Slack" : "Webhook"}</Badge>}
      mono
      title={hook.url}
      meta={
        <span className="block truncate font-mono">
          {hook.events === "*" ? "all events" : hook.events.split(",").join(" · ")}
        </span>
      }
      actions={
        <>
          <Button
            data-testid={`webhook-log-${hook.id}`}
            variant="ghost"
            size="sm"
            onClick={showLog}
          >
            {open ? "Hide" : "Log"}
          </Button>
          <Button
            data-testid={`webhook-test-${hook.id}`}
            variant="ghost"
            size="sm"
            onClick={() => test.mutate()}
            loading={test.isPending}
          >
            Test
          </Button>
          <Button
            data-testid={`webhook-remove-${hook.id}`}
            variant="destructive-ghost"
            size="sm"
            onClick={() => setConfirming(true)}
          >
            Remove
          </Button>
        </>
      }
      below={
        <>
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title="Remove this webhook?"
            description={`Deliveries to ${hook.url} stop immediately.`}
            confirmLabel="Remove"
            onConfirm={() => remove.mutate()}
          />
          {open && (
            <div className="rounded-lg bg-secondary px-3 py-2">
              {isPending ? (
                <div className="flex justify-center py-2">
                  <Spinner />
                </div>
              ) : !deliveries || deliveries.length === 0 ? (
                <div className="text-sm text-muted-foreground">No deliveries yet. Hit Test.</div>
              ) : (
                deliveries.map((d) => (
                  <div key={d.id} className="flex items-center gap-2 py-0.5 text-2xs">
                    <StatusBadge tone={deliveryTone(d.status)}>{d.status}</StatusBadge>
                    <span className="font-mono text-muted-foreground">{d.event_type}</span>
                    {d.attempts > 1 && (
                      <span className="font-mono text-muted-foreground tabular-nums">
                        · {d.attempts} tries
                      </span>
                    )}
                    {d.last_error && (
                      <span className="truncate font-mono text-destructive">· {d.last_error}</span>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </>
      }
    />
  )
}

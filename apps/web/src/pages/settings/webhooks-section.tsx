import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api, type Webhook } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { EmptyState } from "@/components/shared/empty-state"
import { SettingsGroup } from "@/components/shared/settings-group"
import { Spinner } from "@/components/shared/spinner"
import { StatusPanel } from "@/components/shared/status-panel"
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
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SettingsSection } from "./settings-section"
import { ALL_EVENTS } from "./webhook-events"

export function WebhooksSection() {
  const qc = useQueryClient()
  const { data: hooks, isPending, isError, refetch } = useQuery(webhooksQuery())
  const reload = () => qc.invalidateQueries({ queryKey: webhooksQuery().queryKey })

  return (
    <SettingsSection
      title="Webhooks"
      description={
        <>
          Get a POST (or a Slack message) when a comment is added or resolved, or a new version is
          published. Generic payloads are signed with{" "}
          <a
            href="https://www.standardwebhooks.com"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            Standard Webhooks
          </a>{" "}
          headers (<code className="font-mono">webhook-signature</code>), and the legacy{" "}
          <code className="font-mono">X-Derive-Signature</code>.
        </>
      }
    >
      <NewWebhook onCreated={reload} />

      {isPending ? (
        <SettingsListSkeleton />
      ) : isError ? (
        <StatusPanel
          tone="danger"
          title="Couldn't load webhooks"
          description="This is usually temporary."
          action={
            <Button
              variant="outline"
              size="sm"
              data-testid="webhooks-retry"
              onClick={() => refetch()}
            >
              Try again
            </Button>
          }
        />
      ) : !hooks || hooks.length === 0 ? (
        <EmptyState>No webhooks yet. Add one above.</EmptyState>
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

function NewWebhook({ onCreated }: { onCreated: () => void }) {
  const [url, setUrl] = useState("")
  const [kind, setKind] = useState<"generic" | "slack">("generic")
  const [events, setEvents] = useState<string[]>([...ALL_EVENTS])
  const valid = /^https?:\/\//.test(url)
  const toggle = (e: string) =>
    setEvents((cur) => (cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e]))
  const create = useApiMutation({
    mutationFn: () =>
      api.createWebhook({
        url,
        kind,
        events: events.length === ALL_EVENTS.length ? undefined : events,
      }),
    success: "Webhook added",
    onSuccess: () => {
      setUrl("")
      onCreated()
    },
  })
  const add = () => {
    if (valid) create.mutate()
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
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
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder={
            kind === "slack"
              ? "Slack incoming-webhook URL"
              : "https://your-endpoint.example.com/hook"
          }
          className="min-w-60 flex-1"
        />
        <Button
          data-testid="webhook-add"
          variant="secondary"
          size="sm"
          onClick={add}
          loading={create.isPending}
          disabled={create.isPending || !valid}
        >
          {create.isPending ? "Adding…" : "Add"}
        </Button>
      </div>
      <div className="flex flex-wrap gap-3.5">
        {ALL_EVENTS.map((e) => (
          <label
            key={e}
            className="flex items-center gap-1.5 font-mono text-2xs text-muted-foreground"
          >
            <Checkbox
              data-testid={`webhook-event-${e}`}
              checked={events.includes(e)}
              onCheckedChange={() => toggle(e)}
            />
            {e}
          </label>
        ))}
      </div>
    </div>
  )
}

// Delivery outcome → badge tone: delivered is a quiet success, dead (gave up
// retrying) is destructive, anything in flight (pending/retrying) stays neutral.
const deliveryBadge = (status: string): "success" | "destructive" | "default" =>
  status === "delivered" ? "success" : status === "dead" ? "destructive" : "default"

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
    <div data-testid={`webhook-row-${hook.id}`} className="flex flex-col gap-2 py-3">
      <div className="flex items-center gap-2.5">
        <Badge>{hook.kind === "slack" ? "Slack" : "Webhook"}</Badge>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm text-foreground">{hook.url}</div>
          <div className="mt-px font-mono text-2xs text-muted-foreground">
            {hook.events === "*" ? "all events" : hook.events.split(",").join(" · ")}
          </div>
        </div>
        <Button data-testid={`webhook-log-${hook.id}`} variant="ghost" size="sm" onClick={showLog}>
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
      </div>
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
                <Badge variant={deliveryBadge(d.status)}>{d.status}</Badge>
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
    </div>
  )
}

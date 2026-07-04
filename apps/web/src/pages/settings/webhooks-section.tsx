import { useCallback, useEffect, useState } from "react"
import { api, type Delivery, type Webhook } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { EmptyState } from "@/components/shared/empty-state"
import { SettingsGroup } from "@/components/shared/settings-group"
import { Spinner } from "@/components/shared/spinner"
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
import { toast } from "@/components/ui/sonner"
import { ALL_EVENTS } from "./roles"
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SettingsSection } from "./settings-section"

export function WebhooksSection() {
  const [hooks, setHooks] = useState<Webhook[] | null>(null)
  const load = useCallback(
    () =>
      api
        .listWebhooks()
        .then((r) => setHooks(r.webhooks))
        .catch(() => setHooks([])),
    [],
  )
  useEffect(() => {
    load()
  }, [load])

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
      <NewWebhook
        onCreated={(msg) => {
          toast.success(msg)
          load()
        }}
      />

      {hooks === null ? (
        <SettingsListSkeleton />
      ) : hooks.length === 0 ? (
        <EmptyState>No webhooks yet. Add one above.</EmptyState>
      ) : (
        <SettingsGroup>
          {hooks.map((w) => (
            <WebhookRow
              key={w.id}
              hook={w}
              onChanged={(m) => {
                toast.success(m)
                load()
              }}
              onError={(m) => toast.error(m)}
            />
          ))}
        </SettingsGroup>
      )}
    </SettingsSection>
  )
}

function NewWebhook({ onCreated }: { onCreated: (msg: string) => void }) {
  const [url, setUrl] = useState("")
  const [kind, setKind] = useState<"generic" | "slack">("generic")
  const [events, setEvents] = useState<string[]>([...ALL_EVENTS])
  const [busy, setBusy] = useState(false)
  const valid = /^https?:\/\//.test(url)
  const toggle = (e: string) =>
    setEvents((cur) => (cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e]))
  const add = async () => {
    if (!valid) return
    setBusy(true)
    try {
      await api.createWebhook({
        url,
        kind,
        events: events.length === ALL_EVENTS.length ? undefined : events,
      })
      setUrl("")
      onCreated("Webhook added")
    } catch (e) {
      onCreated((e as Error).message)
    } finally {
      setBusy(false)
    }
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
          loading={busy}
          disabled={busy || !valid}
        >
          {busy ? "Adding…" : "Add"}
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

function WebhookRow({
  hook,
  onChanged,
  onError,
}: {
  hook: Webhook
  onChanged: (m: string) => void
  onError: (m: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null)
  const loadLog = () =>
    api
      .webhookDeliveries(hook.id)
      .then((r) => setDeliveries(r.deliveries))
      .catch(() => setDeliveries([]))
  const showLog = () => {
    const next = !open
    setOpen(next)
    if (next) loadLog()
  }
  const test = async () => {
    try {
      await api.testWebhook(hook.id)
      onChanged("Test event queued")
      if (open) setTimeout(loadLog, 1500)
    } catch (e) {
      onError((e as Error).message)
    }
  }
  const [confirming, setConfirming] = useState(false)
  const remove = async () => {
    try {
      await api.deleteWebhook(hook.id)
      onChanged("Webhook removed")
    } catch (e) {
      onError((e as Error).message)
    }
  }
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
        <Button data-testid={`webhook-test-${hook.id}`} variant="ghost" size="sm" onClick={test}>
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
        onConfirm={remove}
      />
      {open && (
        <div className="rounded-lg bg-secondary px-3 py-2">
          {deliveries === null ? (
            <div className="flex justify-center py-2">
              <Spinner />
            </div>
          ) : deliveries.length === 0 ? (
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

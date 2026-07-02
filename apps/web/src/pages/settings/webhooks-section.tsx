import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { api, type Delivery, type Webhook } from "@/api"
import { EmptyState } from "@/components/shared/empty-state"
import { Spinner } from "@/components/shared/spinner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ALL_EVENTS } from "./roles"

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
    <section>
      <p className="mb-4 text-sm text-muted-foreground">
        Get a POST (or a Slack message) when a comment is added or resolved, or a new version is
        published. Generic payloads are signed with{" "}
        <a
          href="https://www.standardwebhooks.com"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          Standard Webhooks
        </a>{" "}
        headers (<code className="font-mono">webhook-signature</code>), and the legacy{" "}
        <code className="font-mono">X-Derive-Signature</code>.
      </p>

      <NewWebhook
        onCreated={(msg) => {
          toast.success(msg)
          load()
        }}
      />

      <div className="mt-4 flex flex-col gap-2.5">
        {hooks === null ? (
          <div className="flex h-20 items-center justify-center">
            <Spinner />
          </div>
        ) : hooks.length === 0 ? (
          <EmptyState>No webhooks yet. Add one above.</EmptyState>
        ) : (
          hooks.map((w) => (
            <WebhookRow
              key={w.id}
              hook={w}
              onChanged={(m) => {
                toast.success(m)
                load()
              }}
              onError={(m) => toast.error(m)}
            />
          ))
        )}
      </div>
    </section>
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
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={kind} onValueChange={(v) => setKind(v as "generic" | "slack")}>
          <SelectTrigger data-testid="webhook-kind" aria-label="Webhook type" className="w-[110px]">
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
          placeholder={
            kind === "slack"
              ? "Slack incoming-webhook URL"
              : "https://your-endpoint.example.com/hook"
          }
          className="min-w-[240px] flex-1"
        />
        <Button
          data-testid="webhook-add"
          variant="secondary"
          size="sm"
          onClick={add}
          disabled={busy || !valid}
        >
          {busy ? "Adding…" : "Add"}
        </Button>
      </div>
      <div className="flex flex-wrap gap-3.5">
        {ALL_EVENTS.map((e) => (
          <label
            key={e}
            className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground"
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
    </Card>
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
  const remove = async () => {
    try {
      await api.deleteWebhook(hook.id)
      onChanged("Webhook removed")
    } catch (e) {
      onError((e as Error).message)
    }
  }
  return (
    <Card data-testid={`webhook-row-${hook.id}`} className="gap-0 overflow-hidden p-0">
      <div className="flex items-center gap-2.5 px-3.5 py-3">
        <Badge variant={hook.kind === "slack" ? "secondary" : "default"}>
          {hook.kind === "slack" ? "Slack" : "Webhook"}
        </Badge>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-xs text-foreground">{hook.url}</div>
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
          variant="ghost"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          size="sm"
          onClick={remove}
        >
          Remove
        </Button>
      </div>
      {open && (
        <div className="border-t border-border-soft bg-secondary px-3.5 py-2">
          {deliveries === null ? (
            <div className="text-xs text-muted-foreground">Loading…</div>
          ) : deliveries.length === 0 ? (
            <div className="text-xs text-muted-foreground">No deliveries yet. Hit Test.</div>
          ) : (
            deliveries.map((d) => {
              return (
                <div key={d.id} className="flex items-center gap-2 py-0.5 text-xs">
                  <Badge variant={deliveryBadge(d.status)}>{d.status}</Badge>
                  <span className="font-mono text-muted-foreground">{d.event_type}</span>
                  {d.attempts > 1 && (
                    <span className="font-mono text-muted-foreground">· {d.attempts} tries</span>
                  )}
                  {d.last_error && (
                    <span className="truncate font-mono text-destructive">· {d.last_error}</span>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}
    </Card>
  )
}

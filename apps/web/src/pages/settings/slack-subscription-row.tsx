import { useState } from "react"
import { api, type SlackSubscription } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { ListRow } from "@/components/shared/list-row"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { slackSubscriptionsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"

/** One subscribed channel: what it hears, from whom, and whether it's live.
 *
 *  The Switch saves quietly — no toast, no optimistic flip: it re-renders from the refetched
 *  subscription once the invalidation lands. The event checkboxes and the author select save
 *  explicitly with a toast, because they change what a whole channel receives and a silent save
 *  would be too quiet for that. */
export function SlackSubscriptionRow({
  sub,
  eventOptions,
  onDone,
}: {
  sub: SlackSubscription
  eventOptions: string[]
  onDone: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const selected = sub.events === "*" ? eventOptions : sub.events.split(",")

  const save = useApiMutation({
    mutationFn: (body: { events?: string[]; authors?: "all" | "human" | "agent" }) =>
      api.updateSlackSubscription(sub.id, body),
    success: "Subscription updated",
    invalidate: [slackSubscriptionsQuery().queryKey],
  })
  const pause = useApiMutation({
    mutationFn: (active: boolean) => api.updateSlackSubscription(sub.id, { active }),
    invalidate: [slackSubscriptionsQuery().queryKey],
  })
  const remove = useApiMutation({
    mutationFn: () => api.deleteSlackSubscription(sub.id),
    success: "Channel unsubscribed",
    onSuccess: () => onDone(),
  })

  const toggleEvent = (e: string) =>
    save.mutate({
      events: selected.includes(e) ? selected.filter((x) => x !== e) : [...selected, e],
    })

  return (
    <ListRow
      title={
        <span className="flex items-center gap-2">
          {sub.channel_name ? `#${sub.channel_name}` : sub.channel_id}
          {/* Name the collection. A channel can carry several scoped subscriptions, and a row that
              just says "collection" gives an admin no way to tell which one Remove would delete. */}
          <Badge>
            {sub.scope_kind === "collection"
              ? (sub.scope_title ?? "deleted collection")
              : "workspace"}
          </Badge>
        </span>
      }
      actions={
        <>
          <Select
            value={sub.authors}
            onValueChange={(v) => save.mutate({ authors: v as "all" | "human" | "agent" })}
          >
            <SelectTrigger
              data-testid={`slack-sub-authors-${sub.id}`}
              aria-label="Whose activity"
              className="w-36"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">People &amp; agents</SelectItem>
              <SelectItem value="human">People only</SelectItem>
              <SelectItem value="agent">Agents only</SelectItem>
            </SelectContent>
          </Select>
          <Switch
            data-testid={`slack-sub-active-${sub.id}`}
            aria-label="Deliver to this channel"
            checked={sub.active === 1}
            onCheckedChange={(next) => pause.mutate(next)}
          />
          <Button
            data-testid={`slack-sub-remove-${sub.id}`}
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
          <div className="flex flex-wrap gap-3.5">
            {eventOptions.map((e) => (
              <label
                key={e}
                className="flex items-center gap-1.5 font-mono text-2xs text-muted-foreground"
              >
                <Checkbox
                  data-testid={`slack-sub-event-${sub.id}-${e}`}
                  checked={selected.includes(e)}
                  onCheckedChange={() => toggleEvent(e)}
                />
                {e}
              </label>
            ))}
          </div>
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title="Unsubscribe this channel?"
            description={`Derive stops posting to ${sub.channel_name ? `#${sub.channel_name}` : sub.channel_id}. Existing threads stay where they are.`}
            confirmLabel="Remove"
            confirmTestId={`slack-sub-remove-confirm-${sub.id}`}
            onConfirm={() => remove.mutate()}
          />
        </>
      }
    />
  )
}

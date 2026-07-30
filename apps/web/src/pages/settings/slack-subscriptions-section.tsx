import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "@/api"
import { EmptyState } from "@/components/shared/empty-state"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { collectionsQuery, slackChannelsQuery, slackSubscriptionsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SlackSubscriptionRow } from "./slack-subscription-row"

/** Which channels hear about what.
 *
 *  Replaces the single "default channel ID" text box: a workspace subscribes any number of
 *  channels, each filtered by event and by whether the author was a person or an agent. The
 *  channel is PICKED, never typed — `/derive subscribe` run inside a channel is the other way
 *  in, and needs no id at all. */
export function SlackSubscriptionsSection() {
  const qc = useQueryClient()
  const { data, isPending, isError, refetch } = useQuery(slackSubscriptionsQuery())
  const reload = () => qc.invalidateQueries({ queryKey: slackSubscriptionsQuery().queryKey })

  return (
    <SettingsGroup
      title="Slack channels"
      description="Where Derive posts. Subscribe a channel here, or run /derive subscribe inside it."
    >
      <NewSubscription onCreated={reload} />
      {isPending ? (
        <SettingsListSkeleton />
      ) : isError ? (
        <StatusPanel
          tone="danger"
          title="Couldn't load Slack subscriptions"
          description="This is usually temporary."
          action={
            <Button
              variant="outline"
              size="sm"
              data-testid="slack-subs-retry"
              onClick={() => refetch()}
            >
              Try again
            </Button>
          }
        />
      ) : !data || data.subscriptions.length === 0 ? (
        <EmptyState>No channels subscribed yet. Add one above.</EmptyState>
      ) : (
        data.subscriptions.map((s) => (
          <SlackSubscriptionRow
            key={s.id}
            sub={s}
            eventOptions={data.event_options}
            onDone={reload}
          />
        ))
      )}
    </SettingsGroup>
  )
}

/** The composer. Channels come from the connected workspace, so there is no id to paste. */
function NewSubscription({ onCreated }: { onCreated: () => void }) {
  const [channel, setChannel] = useState("")
  // "" is the whole workspace, matching the scope_id encoding the API stores.
  const [collection, setCollection] = useState("")
  // Lazily fetched: the list pages through the Slack API, so it loads when the picker opens.
  const [open, setOpen] = useState(false)
  const { data: channels, isError } = useQuery({ ...slackChannelsQuery(), enabled: open })
  const { data: collections } = useQuery(collectionsQuery())

  const create = useApiMutation({
    mutationFn: () =>
      api.createSlackSubscription({
        channel_id: channel,
        channel_name: channels?.find((c) => c.id === channel)?.name,
        collection: collection || undefined,
      }),
    success: "Channel subscribed",
    onSuccess: () => {
      setChannel("")
      setCollection("")
      onCreated()
    },
  })

  return (
    <div className="flex flex-wrap items-center gap-2 py-3">
      <Select value={channel} onValueChange={setChannel} onOpenChange={setOpen}>
        <SelectTrigger
          data-testid="slack-sub-channel"
          aria-label="Channel to subscribe"
          className="w-64"
        >
          <SelectValue placeholder="Pick a channel…" />
        </SelectTrigger>
        <SelectContent>
          {isError ? (
            <SelectItem value="__error" disabled>
              Couldn't load channels
            </SelectItem>
          ) : !channels?.length ? (
            <SelectItem value="__empty" disabled>
              {open ? "No channels found" : "Loading…"}
            </SelectItem>
          ) : (
            channels.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                #{c.name}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
      {/* Scope. A channel can hold several subscriptions, so this is how #eng gets one row for
          the API collection and another for the whole workspace. Only offered when the workspace
          HAS collections — an empty picker is worse than no picker. */}
      {collections?.length ? (
        <Select
          value={collection || "__all"}
          onValueChange={(v) => setCollection(v === "__all" ? "" : v)}
        >
          <SelectTrigger
            data-testid="slack-sub-scope"
            aria-label="What this channel gets"
            className="w-56"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">Everything in the workspace</SelectItem>
            {collections.map((col) => (
              <SelectItem key={col.id} value={col.id}>
                {col.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <Button
        data-testid="slack-sub-add"
        variant="secondary"
        size="sm"
        onClick={() => create.mutate()}
        loading={create.isPending}
        disabled={create.isPending || !channel || channel.startsWith("__")}
      >
        {create.isPending ? "Adding…" : "Subscribe"}
      </Button>
      <p className="w-full text-sm text-muted-foreground">
        Invite the Derive app to a private channel before subscribing it — it can join public
        channels itself.
      </p>
    </div>
  )
}

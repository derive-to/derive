import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api, type Connection } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { EmptyState } from "@/components/shared/empty-state"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { connectionsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SettingsSection } from "./settings-section"

// Sources: connect an MCP server, and an agent working for you can read from it.
//
// This screen existed once and was REMOVED, because the only broker behind it was a stub whose
// `execute` returned the caller's own arguments — so it said "Connected" about something that
// reached nothing. It comes back now because that is no longer true: an MCP connection talks to a
// real server, the tool list is pinned at the moment you approve it, and the echo stub is behind a
// developer flag. "Connected" here means the server answered.
//
// Only MCP is addable. The other connection kinds are either created by their own integration
// flow (GitHub, Slack) or need a broker plan that cannot currently complete a connection.

export function SourcesSection() {
  const qc = useQueryClient()
  const { data: connections, isPending, isError, refetch } = useQuery(connectionsQuery())
  const reload = () => qc.invalidateQueries({ queryKey: connectionsQuery().queryKey })
  const sources = (connections ?? []).filter((c) => c.status !== "revoked")

  return (
    <SettingsSection
      title="Sources"
      description={
        <>
          Connect a Model Context Protocol server and your agents can read from it during a run. The
          server's tools are recorded when you connect, and if that list later changes the
          connection goes quiet until you reconnect — so a server cannot rewrite what your agent
          reads after you have approved it.
        </>
      }
    >
      <AddSource onAdded={reload} />

      {isPending ? (
        <SettingsListSkeleton />
      ) : isError ? (
        <StatusPanel
          tone="danger"
          title="Couldn't load your sources"
          description="This is usually temporary. Your connected sources are unaffected."
          action={
            <Button
              variant="outline"
              size="sm"
              data-testid="sources-retry"
              onClick={() => refetch()}
            >
              Try again
            </Button>
          }
        />
      ) : sources.length === 0 ? (
        <EmptyState
          title="No sources connected"
          description="Add an MCP server above to give your agents something to read."
        />
      ) : (
        <SettingsGroup>
          {sources.map((c) => (
            <SourceRow key={c.id} conn={c} onRevoked={reload} />
          ))}
        </SettingsGroup>
      )}
    </SettingsSection>
  )
}

function AddSource({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [secret, setSecret] = useState("")
  const [error, setError] = useState<string | null>(null)

  const connect = useApiMutation({
    mutationFn: () =>
      api.connectMcp({
        toolkit: name.trim(),
        mcp_url: url.trim(),
        ...(secret.trim() ? { mcp_secret: secret.trim() } : {}),
      }),
    onSuccess: () => {
      setName("")
      setUrl("")
      setSecret("")
      setError(null)
      onAdded()
    },
    // The server's own words. "That MCP server did not answer — if it requires authentication,
    // pass a token" is a better message than anything this component could invent, and it is the
    // difference between a wrong URL and a missing credential.
    onError: (e: Error) => setError(e.message),
  })

  const ready = name.trim().length > 0 && /^https:\/\/|^http:\/\/localhost/.test(url.trim())

  return (
    <div className="mb-6 space-y-3" data-testid="sources-add">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="source-name" className="text-sm font-medium">
            Name
          </label>
          <Input
            id="source-name"
            data-testid="source-name"
            placeholder="weather"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            Prefixes the server's tools, so an agent can see where each one came from.
          </p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="source-url" className="text-sm font-medium">
            Server URL
          </label>
          <Input
            id="source-url"
            data-testid="source-url"
            placeholder="https://example.com/mcp"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <p className="text-muted-foreground text-xs">Must be https.</p>
        </div>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="source-secret" className="text-sm font-medium">
          Token <span className="text-muted-foreground font-normal">(if the server needs one)</span>
        </label>
        <Input
          id="source-secret"
          data-testid="source-secret"
          type="password"
          placeholder="Sent as Authorization: Bearer"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
        <p className="text-muted-foreground text-xs">
          Encrypted, spent on the server, and never shown again — you will only ever see its last
          four characters. Paste the narrowest token the server will accept.
        </p>
      </div>
      {error ? (
        <p className="text-destructive text-sm" data-testid="source-error">
          {error}
        </p>
      ) : null}
      <Button
        data-testid="source-connect"
        disabled={!ready || connect.isPending}
        onClick={() => connect.mutate()}
      >
        {connect.isPending ? "Connecting…" : "Connect"}
      </Button>
    </div>
  )
}

function SourceRow({ conn, onRevoked }: { conn: Connection; onRevoked: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const revoke = useApiMutation({
    mutationFn: () => api.revokeConnection(conn.id),
    onSuccess: onRevoked,
  })

  return (
    <div className="flex items-center justify-between gap-4 py-3" data-testid="source-row">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{conn.toolkit}</span>
          {conn.kind === "mcp" ? <Badge variant="secondary">MCP</Badge> : null}
          {conn.status === "active" ? (
            <Badge variant="outline">Connected</Badge>
          ) : (
            <Badge variant="outline">{conn.status}</Badge>
          )}
        </div>
        <p className="text-muted-foreground truncate text-xs">
          {conn.base_url ?? "—"}
          {conn.scopes_label ? ` · token ${conn.scopes_label}` : ""}
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        data-testid={`source-revoke-${conn.id}`}
        onClick={() => setConfirming(true)}
      >
        Disconnect
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Disconnect ${conn.toolkit}?`}
        description="Runs bound to this source stop being able to read from it. Nothing already written changes."
        confirmLabel="Disconnect"
        onConfirm={() => {
          revoke.mutate()
          setConfirming(false)
        }}
      />
    </div>
  )
}

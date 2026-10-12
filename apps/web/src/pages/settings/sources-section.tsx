import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { api, type Connection } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { ListRow } from "@/components/shared/list-row"
import { LoadError } from "@/components/shared/load-error"
import { SettingsEmpty } from "@/components/shared/settings-empty"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusBadge } from "@/components/shared/status-badge"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { connectionsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useOneShotParams } from "@/lib/use-one-shot-params"
import { IntegrationGroups } from "./integrations-section"
import { SecretsGroup } from "./secrets-group"
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SettingsSection } from "./settings-section"

// Sources: everything an agent can reach outside Derive, on one page. GitHub and Slack
// (integrations-section.tsx), MCP servers an agent reads tools from, and secrets it reads as
// environment variables. An agent is given a source on its Settings tab.
//
// An MCP connection talks to a real server, and its tool list is pinned at the moment you
// approve it. "Connected" here means the server answered.

/** What the OAuth callback writes into `scopes_label` for a connection authenticated by sign-in
 *  rather than by a pasted token. Kept in one place so the row can caption it correctly. */
const SIGNED_IN_LABEL = "signed in"

export function SourcesSection() {
  const qc = useQueryClient()
  const { data: connections, isPending, isError, refetch } = useQuery(connectionsQuery())
  const reload = () => qc.invalidateQueries({ queryKey: connectionsQuery().queryKey })

  // ?connected=1 lands here fresh back from a provider's consent screen. The cached connections
  // query predates the callback that flipped the row active, so consume + strip the param (the
  // shared one-shot idiom) and refetch.
  const { connected } = useOneShotParams("connected")
  const justConnected = connected === "1"
  useEffect(() => {
    if (justConnected) void qc.invalidateQueries({ queryKey: connectionsQuery().queryKey })
  }, [justConnected, qc])
  const servers = (connections ?? []).filter((c) => c.status !== "revoked" && c.kind === "mcp")

  return (
    <SettingsSection
      title="Sources"
      description="What your agents can reach: GitHub, Slack, MCP servers, and secrets they read as environment variables. Give one to an agent on its Settings tab."
    >
      {justConnected ? (
        <StatusPanel
          tone="success"
          title="Source connected"
          description="Its tools were recorded. Give it to an agent to let its jobs read from it."
        />
      ) : null}

      <IntegrationGroups />

      <section className="flex flex-col gap-2" data-testid="sources-tools">
        <SettingsGroup
          title="MCP servers"
          description="Tools are recorded when you connect. If the server's tool list changes later, the source goes quiet until you reconnect."
        >
          {isPending ? (
            <SettingsListSkeleton />
          ) : isError ? (
            <LoadError
              title="Couldn’t load your sources"
              description="This is usually temporary. Your connected sources are unaffected."
              testId="sources-retry"
              onRetry={() => refetch()}
            />
          ) : servers.length === 0 ? (
            <SettingsEmpty>No MCP servers connected.</SettingsEmpty>
          ) : (
            servers.map((c) => <SourceRow key={c.id} conn={c} onRevoked={reload} />)
          )}
        </SettingsGroup>
        <AddSource onAdded={reload} />
      </section>

      <SecretsGroup />
    </SettingsSection>
  )
}

function AddSource({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [secret, setSecret] = useState("")
  const [error, setError] = useState<string | null>(null)

  const connect = useApiMutation({
    mutationFn: async () => {
      const conn = await api.connectMcp({
        toolkit: name.trim(),
        mcp_url: url.trim(),
        ...(secret.trim() ? { mcp_secret: secret.trim() } : {}),
      })
      // PENDING MEANS "NEEDS SIGN-IN". It is the only way an MCP row is stored unusable: every
      // other failure is refused at the door with the reason, so no row exists to be ambiguous.
      //
      // Sending them straight to the provider is what "Connect" does everywhere else on the web,
      // and it is the whole flow for a server like Stripe that has no pasteable key worth using.
      // If this leg fails the row is still there with its own Sign in button, so an abandoned or
      // broken redirect costs a click, not the connection.
      if (conn.status === "pending") {
        const { authorize_url } = await api.authorizeMcp(conn.id)
        return { conn, authorize_url }
      }
      return { conn, authorize_url: null }
    },
    onSuccess: ({ authorize_url }) => {
      setName("")
      setUrl("")
      setSecret("")
      setError(null)
      setOpen(false)
      onAdded()
      if (authorize_url) window.location.href = authorize_url
    },
    // The server's own words. "That MCP server did not answer — if it requires authentication,
    // pass a token" is a better message than anything this component could invent, and it is the
    // difference between a wrong URL and a missing credential.
    onError: (e: Error) => setError(e.message),
  })

  // Enough to know the button would do something, and no more. The server owns the URL policy
  // and its refusal is already what the reader sees (`source-error`, in the server's own words).
  const ready = name.trim().length > 0 && url.trim().length > 0

  if (!open)
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="sources-add-open"
        onClick={() => setOpen(true)}
        className="self-start"
      >
        Add MCP server
      </Button>
    )

  return (
    <form
      className="flex max-w-xl flex-col gap-3 rounded-xl border border-border p-4"
      data-testid="sources-add"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready && !connect.isPending) connect.mutate()
      }}
    >
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
            Prefixes the server's tools, so an agent can see where each came from.
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
        </div>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="source-secret" className="text-sm font-medium">
          Token <span className="text-muted-foreground font-normal">(optional)</span>
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
          Most servers ask you to sign in instead. A pasted token is encrypted and never shown
          again.
        </p>
      </div>
      {error ? (
        <p className="text-destructive text-sm" data-testid="source-error">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          data-testid="source-connect"
          size="sm"
          loading={connect.isPending}
          disabled={!ready || connect.isPending}
        >
          Connect
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="source-cancel"
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}

function SourceRow({ conn, onRevoked }: { conn: Connection; onRevoked: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const revoke = useApiMutation({
    mutationFn: () => api.revokeConnection(conn.id),
    onSuccess: onRevoked,
  })
  // The durable way back into a sign-in: a flow abandoned at the consent screen, a redirect that
  // never came back, or a grant the provider later revoked all land the row here.
  const signIn = useApiMutation({
    mutationFn: () => api.authorizeMcp(conn.id),
    onSuccess: ({ authorize_url }) => {
      window.location.href = authorize_url
    },
    // A server that does not do OAuth says so here, in its own words, rather than looping.
    onError: (e: Error) => setError(e.message),
  })
  const needsSignIn = conn.status === "pending"

  return (
    <ListRow
      data-testid="source-row"
      title={
        <span className="flex items-center gap-2">
          {conn.toolkit}
          {needsSignIn ? (
            <StatusBadge tone="attention">Needs sign-in</StatusBadge>
          ) : conn.status !== "active" ? (
            <StatusBadge tone="muted">{conn.status}</StatusBadge>
          ) : null}
        </span>
      }
      meta={
        <>
          <span className="block truncate">
            {needsSignIn
              ? "Sign in with this server to finish connecting."
              : (conn.base_url ?? "Not available")}
            {/* A signed-in connection has no token to caption. The label says which of the two
                ways this one authenticates. */}
            {!needsSignIn && conn.scopes_label
              ? conn.scopes_label === SIGNED_IN_LABEL
                ? " · signed in"
                : ` · token ${conn.scopes_label}`
              : ""}
          </span>
          {error ? (
            <span className="block text-destructive" data-testid={`source-signin-error-${conn.id}`}>
              {error}
            </span>
          ) : null}
        </>
      }
      actions={
        <>
          {needsSignIn ? (
            <Button
              variant="secondary"
              size="sm"
              data-testid={`source-signin-${conn.id}`}
              disabled={signIn.isPending}
              onClick={() => {
                setError(null)
                signIn.mutate()
              }}
            >
              {signIn.isPending ? "Opening…" : "Sign in"}
            </Button>
          ) : null}
          <Button
            variant="destructive-ghost"
            size="sm"
            data-testid={`source-revoke-${conn.id}`}
            onClick={() => setConfirming(true)}
          >
            Disconnect
          </Button>
        </>
      }
      below={
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={`Disconnect ${conn.toolkit}?`}
          description="Agents given this source can no longer read from it. Nothing already written changes."
          confirmLabel="Disconnect"
          onConfirm={() => {
            revoke.mutate()
            setConfirming(false)
          }}
        />
      }
    />
  )
}

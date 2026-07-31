import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
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
  const [justConnected, setJustConnected] = useState(false)

  // ?connected=1 lands here fresh back from a provider's consent screen. The cached connections
  // query predates the callback that flipped the row active, so consume + strip the param (the
  // same one-shot idiom as billing's ?checkout=success) and refetch.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (url.searchParams.get("connected") === "1") {
      url.searchParams.delete("connected")
      window.history.replaceState(null, "", url)
      setJustConnected(true)
      void qc.invalidateQueries({ queryKey: connectionsQuery().queryKey })
    }
  }, [qc])
  // MCP only, to match what this screen can actually add and explain. A GitHub App or Slack row
  // listed here has its own setup flow elsewhere, no server URL to show, and a `scopes_label`
  // that is an account name — which the row below would caption as "· token acme-corp".
  const sources = (connections ?? []).filter((c) => c.status !== "revoked" && c.kind === "mcp")

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
      {justConnected ? (
        <StatusPanel
          tone="success"
          title="Source connected"
          description="You signed in, and its tools were recorded. Bind it to an automation to let a run read from it."
        />
      ) : null}

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
      onAdded()
      if (authorize_url) window.location.href = authorize_url
    },
    // The server's own words. "That MCP server did not answer — if it requires authentication,
    // pass a token" is a better message than anything this component could invent, and it is the
    // difference between a wrong URL and a missing credential.
    onError: (e: Error) => setError(e.message),
  })

  // Enough to know the button would do something, and no more. This used to carry its own copy
  // of the URL policy — a looser one, which enabled Connect for `http://localhost.evil.com`, a
  // URL the server then refused. Restating a rule the client cannot enforce buys nothing and
  // gives it a second chance to be wrong: `clients-no-core-at-runtime` keeps runtime policy out
  // of the web app on purpose, so the server owns this and its refusal is already what the
  // reader sees (`source-error`, in the server's own words).
  const ready = name.trim().length > 0 && url.trim().length > 0

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
          Token{" "}
          <span className="text-muted-foreground font-normal">
            (optional — most servers sign you in instead)
          </span>
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
          Leave this empty unless the server has no sign-in. If it asks you to authorize, Connect
          takes you there. A token you do paste is encrypted, spent on the server, and never shown
          again — you will only ever see its last four characters.
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
    <div className="flex items-center justify-between gap-4 py-3" data-testid="source-row">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{conn.toolkit}</span>
          {conn.kind === "mcp" ? <Badge variant="secondary">MCP</Badge> : null}
          {conn.status === "active" ? (
            <Badge variant="outline">Connected</Badge>
          ) : needsSignIn ? (
            <Badge variant="outline">Needs sign-in</Badge>
          ) : (
            <Badge variant="outline">{conn.status}</Badge>
          )}
        </div>
        <p className="text-muted-foreground truncate text-xs">
          {needsSignIn
            ? "Sign in with this server to finish connecting. Nothing can read from it until you do."
            : (conn.base_url ?? "—")}
          {!needsSignIn && conn.scopes_label ? ` · token ${conn.scopes_label}` : ""}
        </p>
        {error ? (
          <p className="text-destructive text-xs" data-testid={`source-signin-error-${conn.id}`}>
            {error}
          </p>
        ) : null}
      </div>
      {needsSignIn ? (
        <Button
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

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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { connectionsQuery, workspaceSettingsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useOneShotParams } from "@/lib/use-one-shot-params"
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
  // MCP only, to match what this screen can actually add and explain. A GitHub App or Slack row
  // listed here has its own setup flow elsewhere, no server URL to show, and a `scopes_label`
  // that is an account name — which the row below would caption as "· token acme-corp".
  const sources = (connections ?? []).filter((c) => c.status !== "revoked" && c.kind === "mcp")

  return (
    <SettingsSection
      title="Sources"
      // The second sentence is not decoration: a server that changes its tool list
      // goes quiet, and the row still reads "Connected" while runs read nothing
      // from it. This page is the only place that fact is stated.
      description="Connect an MCP server and your agents can read from it during a run. Its tools are recorded when you connect; if that list changes later, the source goes quiet until you reconnect."
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
        <LoadError
          title="Couldn’t load your sources"
          description="This is usually temporary. Your connected sources are unaffected."
          testId="sources-retry"
          onRetry={() => refetch()}
        />
      ) : sources.length === 0 ? (
        <SettingsEmpty>
          No sources connected — your agents have nothing extra to read.
        </SettingsEmpty>
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

  // A real <form> (Enter in any field submits), but NOT AddForm: this composer is a stacked
  // grid of labelled fields, not AddForm's one-line flex-wrap of controls.
  return (
    <form
      className="mb-6 space-y-3"
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
          Leave empty unless the server has no sign-in. A pasted token is encrypted and never shown
          again.
        </p>
      </div>
      {error ? (
        <p className="text-destructive text-sm" data-testid="source-error">
          {error}
        </p>
      ) : null}
      <Button
        type="submit"
        data-testid="source-connect"
        variant="secondary"
        size="sm"
        loading={connect.isPending}
        disabled={!ready || connect.isPending}
      >
        Connect
      </Button>
    </form>
  )
}

function SourceRow({ conn, onRevoked }: { conn: Connection; onRevoked: () => void }) {
  // CHAT EXPOSURE lives on the source it belongs to, not in a list of ids somewhere else.
  // Connecting a server and letting a conversation spend it are two decisions, and this is
  // where somebody already comes to make the first one.
  const { data: settings } = useQuery(workspaceSettingsQuery())
  const declared = settings?.chatSources ?? []
  const inChat = declared.includes(conn.id)
  const setChat = useApiMutation({
    mutationFn: (on: boolean) =>
      api.updateWorkspaceSettings({
        chatSources: on ? [...declared, conn.id] : declared.filter((id) => id !== conn.id),
      }),
    invalidate: [workspaceSettingsQuery().queryKey],
  })
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
          {conn.kind === "mcp" ? <Badge variant="secondary">MCP</Badge> : null}
          {conn.status === "active" ? (
            <Badge variant="outline">Connected</Badge>
          ) : needsSignIn ? (
            <StatusBadge tone="attention">Needs sign-in</StatusBadge>
          ) : (
            <StatusBadge tone="muted">{conn.status}</StatusBadge>
          )}
        </span>
      }
      meta={
        <>
          <span className="block truncate">
            {needsSignIn
              ? "Sign in with this server to finish connecting. Nothing can read from it until you do."
              : (conn.base_url ?? "—")}
            {/* A signed-in connection has no token to caption, and "token signed in" is what the
                generic form produced. The label says which of the two ways this one authenticates. */}
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
          {/* OFF by default, and per source: a workspace connecting a server has not thereby handed
              every conversation a live tool. A PERSONAL source stays yours even when on — chat
              reaches it for you and for nobody else, which is what its scope already means. */}
          {!needsSignIn ? (
            <label className="flex shrink-0 items-center gap-2 text-xs">
              <Checkbox
                checked={inChat}
                disabled={setChat.isPending}
                onCheckedChange={(v) => setChat.mutate(v === true)}
                data-testid={`source-chat-${conn.id}`}
              />
              <span className="text-muted-foreground">
                {conn.scope === "workspace" ? "Chat (everyone)" : "Chat (just me)"}
              </span>
            </label>
          ) : null}
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
          description="Runs bound to this source stop being able to read from it. Nothing already written changes."
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

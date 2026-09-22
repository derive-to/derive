import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { api, type Connection, type ContextDetail } from "@/api"
import { LoadError } from "@/components/shared/load-error"
import { SectionTitle } from "@/components/shared/section-title"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { CONTEXT_ENVIRONMENT_LIMIT, contextEnvironmentNameError } from "@/lib/context-environment"
import { automationConnectionsQuery, contextEnvironmentQuery, contextQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { RuntimeRunCard } from "./runtime-run-card"

export function RuntimeAccessCard({ context }: { context: ContextDetail }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="flex flex-col gap-2 rounded-xl border bg-card p-3.5">
        <SectionTitle>Agent access</SectionTitle>
        <p className="text-xs text-muted-foreground">
          Choose connections and environment variables for this Context.
        </p>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" data-testid="context-runtime-access">
              Manage access
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-screen overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Agent access</DialogTitle>
            </DialogHeader>
            {open && <AccessEditor contextId={context.id} />}
          </DialogContent>
        </Dialog>
      </div>
      <RuntimeRunCard contextId={context.id} />
    </>
  )
}

function AccessEditor({ contextId }: { contextId: string }) {
  // Permission edits must start from the server's current grants, not a persisted page cache.
  const details = useQuery({
    ...contextQuery(contextId),
    staleTime: 0,
    refetchOnMount: "always",
  })
  const connections = useQuery({
    ...automationConnectionsQuery(),
    staleTime: 0,
    refetchOnMount: "always",
  })
  const environment = useQuery(contextEnvironmentQuery(contextId))
  if (details.isError || connections.isError || environment.isError)
    return (
      <LoadError
        title="Couldn’t load agent access"
        testId="context-runtime-retry"
        onRetry={() => {
          void details.refetch()
          void connections.refetch()
          void environment.refetch()
        }}
      />
    )
  if (
    !details.data ||
    !details.isFetchedAfterMount ||
    !connections.isFetchedAfterMount ||
    !environment.isFetchedAfterMount ||
    !connections.data ||
    !environment.data
  )
    return <p className="text-sm text-muted-foreground">Loading access…</p>
  return (
    <AccessForm
      context={details.data}
      connections={connections.data}
      bindings={environment.data.bindings}
    />
  )
}

function AccessForm({
  context,
  connections,
  bindings,
}: {
  context: ContextDetail
  connections: Connection[]
  bindings: Record<string, string>
}) {
  const qc = useQueryClient()
  const [name, setName] = useState("")
  const [value, setValue] = useState("")
  const contextKey = contextQuery(context.id).queryKey
  const environmentKey = contextEnvironmentQuery(context.id).queryKey
  const variable = name.trim()
  const nameError = contextEnvironmentNameError(variable)
  const atLimit =
    !Object.hasOwn(bindings, variable) && Object.keys(bindings).length >= CONTEXT_ENVIRONMENT_LIMIT
  const saveSources = useApiMutation({
    mutationFn: async (ids: string[]) => {
      await qc.cancelQueries({ queryKey: contextKey, exact: true })
      const saved = await api.setContextConnections(context.id, ids)
      // Apply the response before re-enabling edits; a background refresh must not be
      // the only thing stopping the next whole-list write from restoring old grants.
      qc.setQueryData<ContextDetail>(
        contextKey,
        (current) => current && { ...current, connection_ids: saved.connection_ids },
      )
      return saved
    },
    invalidate: [contextKey],
    success: "Connections updated",
  })
  const persistEnvironment = async (next: Record<string, string>) => {
    await qc.cancelQueries({ queryKey: environmentKey, exact: true })
    const saved = await api.setContextEnvironment(context.id, next)
    qc.setQueryData(environmentKey, saved)
    return saved
  }
  const saveEnvironment = useApiMutation({
    mutationFn: persistEnvironment,
    invalidate: [environmentKey],
    success: "Environment updated",
  })
  const add = useApiMutation({
    mutationFn: async () => {
      if (nameError) throw new Error(nameError)
      if (atLimit) throw new Error(`At most ${CONTEXT_ENVIRONMENT_LIMIT} environment variables`)
      const connection = await api.createSecretConnection({
        toolkit: "environment",
        secret: value,
        scopes_label: variable,
      })
      // If binding fails, keep the encrypted connection available in the existing-secret picker.
      setValue("")
      return persistEnvironment({ ...bindings, [variable]: connection.id })
    },
    invalidate: [environmentKey, automationConnectionsQuery().queryKey],
    onSuccess: () => setName(""),
    success: "Environment variable saved",
  })
  const busy = saveEnvironment.isPending || add.isPending
  const canBind = !busy && !nameError && !atLimit
  const sources = connections.filter(
    (c) => c.kind !== "secret" || !!c.base_url || context.connection_ids.includes(c.id),
  )
  const activeIds = new Set(connections.filter((c) => c.status === "active").map((c) => c.id))
  const secrets = connections.filter((c) => c.kind === "secret" && c.status === "active")
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <SectionTitle>Connections</SectionTitle>
        <p className="text-xs text-muted-foreground">
          GitHub uses the repositories and actions allowed by the connected installation. This does
          not grant shell access to clone or push.
        </p>
        {sources.map((source) => (
          <label key={source.id} className="flex items-center gap-2 text-sm">
            <Checkbox
              data-testid={`context-source-${source.id}`}
              checked={context.connection_ids.includes(source.id)}
              disabled={
                saveSources.isPending ||
                (source.status !== "active" && !context.connection_ids.includes(source.id))
              }
              onCheckedChange={(checked) =>
                saveSources.mutate(
                  checked
                    ? [...context.connection_ids, source.id]
                    : context.connection_ids.filter((id) => id !== source.id),
                )
              }
            />
            <span>
              {source.toolkit}
              {source.scopes_label ? ` · ${source.scopes_label}` : ""}
              {source.status !== "active" ? ` (${source.status})` : ""}
            </span>
          </label>
        ))}
        {context.connection_ids.some((id) => !activeIds.has(id)) && (
          <Button
            size="sm"
            variant="outline"
            data-testid="context-sources-remove-unavailable"
            disabled={saveSources.isPending}
            onClick={() =>
              saveSources.mutate(context.connection_ids.filter((id) => activeIds.has(id)))
            }
          >
            Remove unavailable connections
          </Button>
        )}
        <Link
          to="/settings/$section"
          params={{ section: "github" }}
          data-testid="context-connect-github"
          className="text-sm text-primary underline"
        >
          Connect GitHub
        </Link>
      </section>
      <section className="flex flex-col gap-3">
        <SectionTitle>Environment variables</SectionTitle>
        <p className="text-xs text-muted-foreground">
          Selected secrets are given to this Context’s CLI runner at the start of each run. The
          agent can read and use them. In-app chat tools do not receive these values. Removing
          access prevents future retrieval; it cannot erase values from a process already running.
        </p>
        {Object.entries(bindings).map(([variable, id]) => (
          <div key={variable} className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <code className="text-sm">{variable}</code>
              <p className="text-xs text-muted-foreground">
                {connections.find((c) => c.id === id)?.status === "active"
                  ? "Value stored encrypted"
                  : "Connection unavailable"}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              data-testid={`context-env-remove-${variable}`}
              onClick={() =>
                saveEnvironment.mutate(
                  Object.fromEntries(Object.entries(bindings).filter(([key]) => key !== variable)),
                )
              }
            >
              Remove
            </Button>
          </div>
        ))}
        {Object.values(bindings).some((id) => !activeIds.has(id)) && (
          <Button
            size="sm"
            variant="outline"
            data-testid="context-env-remove-unavailable"
            disabled={busy}
            onClick={() =>
              saveEnvironment.mutate(
                Object.fromEntries(Object.entries(bindings).filter(([, id]) => activeIds.has(id))),
              )
            }
          >
            Remove unavailable variables
          </Button>
        )}
        <label className="flex flex-col gap-1 text-sm">
          Variable name
          <Input
            data-testid="context-env-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="DATABASE_URL"
            maxLength={64}
            aria-invalid={!!name && !!nameError}
            autoComplete="off"
            disabled={busy}
          />
        </label>
        {(name && nameError) || atLimit ? (
          <p className="text-xs text-destructive" role="alert">
            {atLimit ? `At most ${CONTEXT_ENVIRONMENT_LIMIT} environment variables` : nameError}
          </p>
        ) : null}
        <label className="flex flex-col gap-1 text-sm">
          New value
          <Input
            data-testid="context-env-value"
            type="password"
            maxLength={4096}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="new-password"
            disabled={busy}
          />
        </label>
        <Button
          data-testid="context-env-add"
          disabled={!canBind || !value || value.includes("\0")}
          onClick={() => add.mutate()}
        >
          {add.isPending ? "Saving…" : "Save variable"}
        </Button>
        {secrets.length > 0 && (
          <label className="flex flex-col gap-1 text-sm">
            Or use an existing secret
            <select
              className="rounded-md border bg-background p-2 text-sm"
              data-testid="context-env-existing"
              value=""
              disabled={!canBind}
              onChange={(e) => {
                if (e.target.value)
                  saveEnvironment.mutate({ ...bindings, [variable]: e.target.value })
              }}
            >
              <option value="">Choose a secret for this variable</option>
              {secrets.map((secret) => (
                <option key={secret.id} value={secret.id}>
                  {secret.scopes_label ?? secret.toolkit}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>
    </div>
  )
}

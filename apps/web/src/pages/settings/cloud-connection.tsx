import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { ListRow } from "@/components/shared/list-row"
import { LoadError } from "@/components/shared/load-error"
import { SettingsGroup } from "@/components/shared/settings-group"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useApiMutation } from "@/lib/use-api-mutation"
import { SettingsListSkeleton } from "./settings-list-skeleton"

export function CloudConnection() {
  const connection = useQuery({ queryKey: ["compute-connection"], queryFn: api.computeConnection })
  const [editing, setEditing] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [provider, setProvider] = useState<"boat" | "ortam">("ortam")
  const [value, setValue] = useState("")
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const invalidate = [["compute-connection"], ["agents"], ["account-login-options"]]
  const connect = useApiMutation({
    mutationFn: () => api.connectCompute(value.trim(), provider),
    invalidate,
    onSuccess: () => {
      setValue("")
      setEditing(false)
    },
  })
  const disconnect = useApiMutation({ mutationFn: api.disconnectCompute, invalidate })
  const setup = useApiMutation({
    mutationFn: () => api.configureCompute(snapshot?.trim() || null),
    invalidate,
    onSuccess: () => setSnapshot(null),
  })
  if (connection.isPending || connection.isError)
    return (
      <SettingsGroup title="Cloud compute">
        {connection.isPending ? (
          <SettingsListSkeleton rows={1} />
        ) : (
          <LoadError
            layout="inline"
            title="Couldn't load cloud compute"
            testId="compute-retry"
            onRetry={() => void connection.refetch()}
          />
        )}
      </SettingsGroup>
    )
  const cn = connection.data
  const editingLabel = provider === "boat" ? "boat.dev" : "Ortam"
  const label = cn.connected
    ? cn.provider === "boat"
      ? "boat.dev"
      : "Ortam"
    : editing
      ? editingLabel
      : cn.managed
        ? "Derive cloud"
        : "Your sandbox"
  const status = !cn.available
    ? "Cloud compute isn't enabled on this server yet."
    : cn.connected
      ? cn.managed
        ? "Your own account runs this workspace's cloud work. Disconnect it to go back to Derive cloud."
        : "Connected for everyone in this workspace."
      : cn.managed
        ? "Included. Cloud tasks and sessions run on Derive's machines."
        : cn.can_manage
          ? "Connect your company's sandbox account once, for everyone in this workspace."
          : "Ask a workspace owner to connect a sandbox."
  return (
    <div data-testid="compute-connection">
      <SettingsGroup
        title="Cloud compute"
        description={
          cn.managed && !cn.connected
            ? "Connect your own boat.dev or Ortam account instead to run on it and pay that provider directly. Model accounts and API keys are separate."
            : "Your company pays its sandbox provider directly. Model accounts and API keys are separate."
        }
      >
        <ListRow
          title={label}
          meta={status}
          stackActions
          actions={
            cn.available && cn.can_manage && !editing ? (
              <>
                <Button
                  type="button"
                  variant={cn.connected || cn.managed ? "ghost" : "outline"}
                  size="sm"
                  data-testid="compute-connect"
                  onClick={() => {
                    setEditing(true)
                    setProvider(cn.provider)
                    connect.reset()
                  }}
                >
                  {cn.connected
                    ? "Replace key"
                    : cn.managed
                      ? "Use your own account"
                      : "Connect sandbox"}
                </Button>
                {cn.connected && (
                  <Button
                    type="button"
                    variant="destructive-ghost"
                    size="sm"
                    data-testid="compute-disconnect"
                    onClick={() => setRemoving(true)}
                  >
                    Disconnect
                  </Button>
                )}
              </>
            ) : undefined
          }
          below={
            <>
              {cn.connected && (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">Connection details</summary>
                  <p className="mt-2 break-all">
                    {label} account: {cn.account_id}
                  </p>
                  {cn.provider === "boat" && (
                    <p className="mt-1">Runner snapshot: {cn.snapshot ?? "Plain sandbox"}</p>
                  )}
                </details>
              )}
              {cn.connected && cn.can_manage && cn.provider === "boat" && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground">Runner setup</summary>
                  <form
                    className="mt-3 max-w-xl space-y-3"
                    data-testid="compute-runner-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      setup.mutate()
                    }}
                  >
                    <Label htmlFor="boat-snapshot">Boat snapshot</Label>
                    <Input
                      id="boat-snapshot"
                      data-testid="compute-snapshot"
                      value={snapshot ?? cn.snapshot ?? ""}
                      onChange={(event) => {
                        setSnapshot(event.target.value)
                        setup.reset()
                      }}
                      disabled={setup.isPending}
                      placeholder="Leave blank for a plain sandbox"
                    />
                    <p className="text-xs text-muted-foreground">
                      Use your company’s snapshot to include its code and tools. New agents use this
                      setup. Existing agents keep their files. Use only a snapshot this workspace
                      may access.
                    </p>
                    {setup.error && (
                      <p role="alert" className="text-sm text-destructive">
                        {setup.error.message}
                      </p>
                    )}
                    <Button
                      type="submit"
                      size="sm"
                      data-testid="compute-runner-save"
                      loading={setup.isPending}
                      disabled={snapshot === null || setup.isPending}
                    >
                      Save setup
                    </Button>
                  </form>
                </details>
              )}
              {editing && cn.can_manage && (
                <form
                  className="max-w-xl space-y-3"
                  data-testid="compute-form"
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (value.trim() && !connect.isPending) connect.mutate()
                  }}
                >
                  {!cn.connected && (
                    <fieldset className="space-y-2" disabled={connect.isPending}>
                      <legend className="text-sm font-medium">Sandbox provider</legend>
                      <div className="flex gap-2">
                        {(["ortam", "boat"] as const).map((option) => (
                          <Button
                            key={option}
                            type="button"
                            variant={provider === option ? "default" : "outline"}
                            data-testid={`compute-provider-${option}`}
                            aria-pressed={provider === option}
                            onClick={() => {
                              setProvider(option)
                              setValue("")
                              connect.reset()
                            }}
                          >
                            {option === "boat" ? "boat.dev" : "Ortam"}
                          </Button>
                        ))}
                      </div>
                    </fieldset>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="sandbox-api-key">{editingLabel} API key</Label>
                    <Input
                      id="sandbox-api-key"
                      data-testid="compute-api-key"
                      type="password"
                      autoComplete="off"
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      placeholder="Paste your account API key"
                      disabled={connect.isPending}
                    />
                    <p className="text-xs text-muted-foreground">
                      Create a key in your{" "}
                      <a
                        href={
                          provider === "boat"
                            ? "https://boat.dev/dashboard"
                            : "https://app.ortam.dev"
                        }
                        target="_blank"
                        rel="noreferrer"
                        data-testid="compute-get-key"
                        className="underline"
                      >
                        {editingLabel} dashboard
                      </a>
                      . We check access and store it encrypted.
                      {provider === "ortam" && " Allow sandbox read and write access on the key."}
                    </p>
                  </div>
                  {connect.error && (
                    <p role="alert" className="text-sm text-destructive">
                      {connect.error.message}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button
                      type="submit"
                      data-testid="compute-save"
                      loading={connect.isPending}
                      disabled={!value.trim() || connect.isPending}
                    >
                      {connect.isPending ? "Checking access…" : "Connect"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      data-testid="compute-cancel"
                      disabled={connect.isPending}
                      onClick={() => {
                        setValue("")
                        setEditing(false)
                        connect.reset()
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
              {disconnect.error && (
                <p role="alert" className="text-sm text-destructive">
                  {disconnect.error.message}
                </p>
              )}
            </>
          }
        />
      </SettingsGroup>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Disconnect ${label}?`}
        description="Active cloud work stops. Queued tasks wait for a connection. Ortam agent sandboxes and their files are deleted during cleanup. Boat sandboxes are archived. Wait for cleanup before switching providers."
        confirmLabel="Disconnect"
        contentTestId="compute-disconnect-dialog"
        onConfirm={async () => {
          await disconnect.mutateAsync()
          setRemoving(false)
        }}
      />
    </div>
  )
}

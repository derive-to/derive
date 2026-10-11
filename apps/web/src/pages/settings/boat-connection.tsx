import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { LoadError } from "@/components/shared/load-error"
import { SectionTitle } from "@/components/shared/section-title"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useApiMutation } from "@/lib/use-api-mutation"

export function BoatConnection() {
  const connection = useQuery({ queryKey: ["compute-connection"], queryFn: api.computeConnection })
  const [editing, setEditing] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [value, setValue] = useState("")
  const invalidate = [["compute-connection"], ["agents"], ["account-login-options"]]
  const connect = useApiMutation({
    mutationFn: () => api.connectCompute(value.trim()),
    invalidate,
    onSuccess: () => {
      setValue("")
      setEditing(false)
    },
  })
  const disconnect = useApiMutation({ mutationFn: api.disconnectCompute, invalidate })
  if (connection.isPending)
    return <p className="text-sm text-muted-foreground">Loading cloud compute…</p>
  if (connection.isError)
    return (
      <LoadError
        title="Couldn’t load cloud compute."
        testId="compute-retry"
        onRetry={() => void connection.refetch()}
      />
    )
  const cn = connection.data
  return (
    <section className="flex flex-col gap-3" data-testid="compute-connection">
      <SectionTitle>Cloud compute</SectionTitle>
      <div className="rounded-xl border border-border p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-medium">boat.dev</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {cn.connected
                ? "Connected for everyone in this workspace."
                : "Connect your company’s boat.dev account once. Everyone in this workspace can run cloud tasks."}
            </p>
          </div>
          {cn.available && cn.can_manage && !editing && (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant={cn.connected ? "outline" : "default"}
                data-testid="compute-connect"
                onClick={() => {
                  setEditing(true)
                  connect.reset()
                }}
              >
                {cn.connected ? "Replace key" : "Connect boat.dev"}
              </Button>
              {cn.connected && (
                <Button
                  type="button"
                  variant="ghost"
                  data-testid="compute-disconnect"
                  onClick={() => setRemoving(true)}
                >
                  Disconnect
                </Button>
              )}
            </div>
          )}
        </div>
        {!cn.available && (
          <p className="mt-3 text-sm text-muted-foreground">
            Cloud compute is not enabled on this server yet.
          </p>
        )}
        {cn.available && !cn.can_manage && !cn.connected && (
          <p className="mt-3 text-sm text-muted-foreground">
            Ask a workspace owner to connect boat.dev.
          </p>
        )}
        <p className="mt-3 text-sm text-muted-foreground">
          Your company pays boat.dev directly. Other workspaces use their own connection. Model
          plans and API keys are separate.
        </p>
        {cn.connected && (
          <details className="mt-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer">Connection details</summary>
            <p className="mt-2 break-all">boat.dev account: {cn.account_id}</p>
          </details>
        )}
        {editing && cn.can_manage && (
          <form
            className="mt-4 max-w-xl space-y-3"
            data-testid="compute-form"
            onSubmit={(e) => {
              e.preventDefault()
              if (value.trim() && !connect.isPending) connect.mutate()
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="boat-api-key">boat.dev API key</Label>
              <Input
                id="boat-api-key"
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
                  href="https://boat.dev/dashboard"
                  target="_blank"
                  rel="noreferrer"
                  data-testid="compute-get-key"
                  className="underline"
                >
                  boat.dev dashboard
                </a>
                . We check access and store it encrypted.
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
          <p role="alert" className="mt-3 text-sm text-destructive">
            {disconnect.error.message}
          </p>
        )}
      </div>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title="Disconnect boat.dev?"
        description="Active cloud work stops. Queued tasks wait until your workspace connects again. Saved files stay in boat.dev."
        confirmLabel="Disconnect"
        contentTestId="compute-disconnect-dialog"
        onConfirm={async () => {
          await disconnect.mutateAsync()
          setRemoving(false)
        }}
      />
    </section>
  )
}

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api, type CloudModelConnection } from "@/api"
import { LoadError } from "@/components/shared/load-error"
import { modelCredentialsQuery, runtimeModelConnectionsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { ModelAccountConnection, NewModelAccount } from "./model-account-connection"

/** Account selection and connection are the same journey in Settings and workflow setup.
 * Imported task credentials remain visible, but can never be submitted as runtime grants. */
export function ModelAccountPicker({
  value,
  onChange,
  disabled = false,
  assigned,
}: {
  value: string
  onChange: (account: CloudModelConnection) => void
  disabled?: boolean
  assigned?: Pick<CloudModelConnection, "id" | "name" | "provider"> | null
}) {
  const client = useQueryClient()
  const signIn = useApiMutation({
    mutationFn: (account: CloudModelConnection) => api.startRuntimeModelSignIn(account.id),
    onSuccess: (attempt, account) =>
      client.setQueryData(["runtime-model-sign-in", account.id], attempt),
  })
  const accounts = useQuery(runtimeModelConnectionsQuery())
  const imported = useQuery(modelCredentialsQuery())
  const chosen = accounts.data?.items.find((account) => account.id === value)
  return (
    <div className="flex flex-col gap-3">
      {accounts.isError ? (
        <LoadError
          title="Could not load your accounts"
          testId="model-accounts-retry"
          onRetry={() => accounts.refetch()}
        />
      ) : (
        <label className="flex flex-col gap-1.5 text-sm">
          Account
          <select
            data-testid="model-account-select"
            className="h-9 rounded-lg border bg-background px-2 text-sm"
            value={value}
            disabled={disabled || accounts.isPending}
            onChange={(event) => {
              const account = accounts.data?.items.find((item) => item.id === event.target.value)
              if (account) onChange(account)
            }}
          >
            <option value="" disabled>
              Choose an account
            </option>
            {assigned && !accounts.data?.items.some((account) => account.id === assigned.id) && (
              <option value={assigned.id}>{assigned.name} · Shared with this workflow</option>
            )}
            {accounts.data?.items.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} · {account.provider === "codex" ? "Codex" : "Claude"}
                {account.revoked_at
                  ? " · Disconnected"
                  : account.unavailable_reason
                    ? " · Unavailable"
                    : ""}
              </option>
            ))}
            {imported.data?.map((account) => (
              <option key={account.provider} value={`imported:${account.provider}`} disabled>
                {account.provider === "codex" ? "Codex" : "Claude"} · Manual import · Tasks and
                conversations only
              </option>
            ))}
          </select>
        </label>
      )}
      {!!imported.data?.length && (
        <p className="text-xs text-muted-foreground">
          Your imported accounts still work for tasks and conversations. To keep files between
          workflow runs, connect through provider sign-in below. This does not replace your existing
          login.
        </p>
      )}
      {imported.isError && (
        <LoadError
          title="Could not check imported accounts"
          testId="model-account-imports-retry"
          onRetry={() => imported.refetch()}
        />
      )}
      {accounts.data?.unavailable_reason && (
        <p className="text-sm text-muted-foreground">{accounts.data.unavailable_reason}</p>
      )}
      {accounts.data?.can_create && (
        <NewModelAccount
          disabled={disabled || signIn.isPending}
          onCreated={(account) => {
            // Select before sign-in so a provider failure can be retried in place.
            signIn.mutate(account)
            onChange(account)
          }}
        />
      )}
      {signIn.isPending && <p className="text-sm">Starting provider sign-in…</p>}
      {chosen?.unavailable_reason && (
        <p className="text-sm text-muted-foreground">{chosen.unavailable_reason}</p>
      )}
      {chosen && (
        <ModelAccountConnection
          key={chosen.id}
          account={chosen}
          canConnect={!!accounts.data?.can_create && !disabled && !signIn.isPending}
        />
      )}
      {assigned && value === assigned.id && !chosen && !accounts.isPending && !accounts.isError && (
        <p className="text-sm text-muted-foreground">
          The account owner manages sign-in. Authorized teammates can run this workflow using its
          assigned account.
        </p>
      )}
    </div>
  )
}

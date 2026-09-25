import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { LoadError } from "@/components/shared/load-error"
import { Button } from "@/components/ui/button"
import { credentialsQuery } from "@/lib/queries"
import { CredentialForm } from "./credential-form"

/** Saving and binding are separate: a failed assignment leaves the saved credential selected. */
export function CredentialPicker({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (id: string) => void
  disabled: boolean
}) {
  const credentials = useQuery(credentialsQuery())
  const [creating, setCreating] = useState(false)
  if (credentials.isError && !credentials.data)
    return (
      <LoadError
        title="Couldn’t load credentials"
        testId="credential-picker-retry"
        onRetry={() => void credentials.refetch()}
      />
    )
  if (!credentials.data)
    return <p className="text-sm text-muted-foreground">Loading credentials…</p>
  const items = credentials.data.items.filter((item) => item.can_use)
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Credential
        <select
          data-testid="credential-picker"
          className="rounded-md border bg-background p-2 text-sm"
          value={value}
          disabled={disabled || creating}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Choose a credential</option>
          {value && !items.some((item) => item.id === value) && (
            <option value={value}>Saved credential · refreshing…</option>
          )}
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {item.scope === "personal" ? "Personal" : "Workspace"}
            </option>
          ))}
        </select>
      </label>
      {creating ? (
        <CredentialForm
          canCreateWorkspace={credentials.data.can_create_workspace}
          onSaved={(id) => {
            onChange(id)
            setCreating(false)
          }}
          onCancel={() => setCreating(false)}
        />
      ) : (
        <div className="flex items-center gap-3">
          <Button
            data-testid="credential-picker-add"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              onChange("")
              setCreating(true)
            }}
          >
            Add credential
          </Button>
          <Link
            to="/settings/$section"
            params={{ section: "credentials" }}
            data-testid="credential-picker-manage"
            className="text-sm text-primary underline"
          >
            Manage credentials
          </Link>
        </div>
      )}
    </div>
  )
}

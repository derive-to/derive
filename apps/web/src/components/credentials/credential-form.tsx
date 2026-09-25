import { useState } from "react"
import { api, type Credential } from "@/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useApiMutation } from "@/lib/use-api-mutation"

export const credentialInvalidations = [
  ["credentials"],
  ["connections"],
  ["contexts"],
  ["workflow-runtimes"],
]

/** Values live only in this mounted form; mutation variables and query data contain no secrets. */
export function CredentialForm({
  credential,
  canCreateWorkspace = false,
  onSaved,
  onCancel,
}: {
  credential?: Credential
  canCreateWorkspace?: boolean
  onSaved: (id: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(credential?.name ?? "")
  const [secret, setSecret] = useState("")
  const [scope, setScope] = useState<"personal" | "workspace">("personal")
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  // An explicit edit starts a new operation; an unchanged retry reuses its request ID.
  const edited = () => setRequestId(crypto.randomUUID())
  const save = useApiMutation<{ id: string }>({
    mutationFn: () =>
      credential
        ? api.replaceCredential(credential.id, {
            name: name.trim(),
            secret,
            revision: credential.revision,
          })
        : api.createCredential({ name: name.trim(), secret, scope, request_id: requestId }),
    invalidate: credentialInvalidations,
    onSuccess: (saved) => {
      setSecret("")
      onSaved(saved.id)
    },
    success: credential ? "Credential replaced" : "Credential saved",
  })
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        Name
        <Input
          data-testid="credential-name"
          value={name}
          maxLength={200}
          autoComplete="off"
          disabled={save.isPending}
          placeholder="Reporting database"
          onChange={(event) => {
            setName(event.target.value)
            edited()
          }}
        />
      </label>
      {!credential && (
        <label className="flex flex-col gap-1 text-sm">
          Available to
          <select
            data-testid="credential-scope"
            className="rounded-md border bg-background p-2 text-sm"
            value={scope}
            disabled={save.isPending}
            onChange={(event) => {
              setScope(event.target.value as "personal" | "workspace")
              edited()
            }}
          >
            <option value="personal">Personal — only you can assign it</option>
            {canCreateWorkspace && (
              <option value="workspace">Workspace — managers can assign it</option>
            )}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm">
        {credential ? "New value" : "Secret value"}
        <Input
          data-testid="credential-value"
          type="password"
          value={secret}
          maxLength={4096}
          autoComplete="new-password"
          disabled={save.isPending}
          onChange={(event) => {
            setSecret(event.target.value)
            edited()
          }}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        Stored encrypted. You can replace this value later, but cannot view it again. Derive does
        not check whether it works.
      </p>
      <div className="flex gap-2">
        <Button
          data-testid="credential-save"
          type="submit"
          disabled={save.isPending || !name.trim() || !secret || secret.includes("\0")}
        >
          {save.isPending ? "Saving…" : credential ? "Replace value" : "Save credential"}
        </Button>
        <Button
          data-testid="credential-cancel"
          type="button"
          variant="ghost"
          disabled={save.isPending}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}

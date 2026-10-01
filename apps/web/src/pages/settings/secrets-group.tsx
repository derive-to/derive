import { useQuery } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { api, type Credential } from "@/api"
import { CredentialForm, credentialInvalidations } from "@/components/credentials/credential-form"
import { ListRow } from "@/components/shared/list-row"
import { LoadError } from "@/components/shared/load-error"
import { SettingsEmpty } from "@/components/shared/settings-empty"
import { SettingsGroup } from "@/components/shared/settings-group"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { credentialsQuery, credentialUsageQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { SettingsListSkeleton } from "./settings-list-skeleton"

/** Settings › Sources › Secrets: database passwords, API keys and other values agents read as
 *  environment variables. Values are write-only: add, replace, or revoke, and see where each is
 *  used. `/settings/credentials` lands here (#secrets). */
export function SecretsGroup() {
  const credentials = useQuery(credentialsQuery())
  const [creating, setCreating] = useState(false)
  // Keep the version the user chose; a background refresh must not silently approve a newer value.
  const [selected, setSelected] = useState<Credential | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const loaded = !!credentials.data
  // An old /settings/credentials link arrives as #secrets: bring the group into view once it
  // has its rows, so the page does not jump after they load.
  useEffect(() => {
    if (loaded && window.location.hash === "#secrets") ref.current?.scrollIntoView()
  }, [loaded])
  return (
    <div id="secrets" ref={ref}>
      <SettingsGroup
        title="Secrets"
        description="Values your agents read as environment variables. Write-only: once saved, a value is never shown again."
        action={
          credentials.data ? (
            <Button
              variant="ghost"
              size="sm"
              data-testid="credentials-add"
              onClick={() => setCreating(true)}
            >
              Add secret
            </Button>
          ) : undefined
        }
      >
        {credentials.isError ? (
          <LoadError
            title="Couldn’t load secrets"
            testId="credentials-retry"
            onRetry={() => void credentials.refetch()}
          />
        ) : !credentials.data ? (
          <SettingsListSkeleton />
        ) : credentials.data.items.length === 0 ? (
          <SettingsEmpty>No secrets saved.</SettingsEmpty>
        ) : (
          credentials.data.items.map((credential) => (
            <ListRow
              key={credential.id}
              data-testid={`credential-row-${credential.id}`}
              title={credential.name}
              meta={
                // Silence for the default: an active secret says only whose it is.
                [
                  credential.scope === "personal" ? "Personal" : "Workspace",
                  credential.status === "revoked"
                    ? "Revoked"
                    : credential.status === "pending"
                      ? "Pending"
                      : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              }
              actions={
                credential.can_manage ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid={`credential-manage-${credential.id}`}
                    onClick={() => setSelected(credential)}
                  >
                    Manage
                  </Button>
                ) : undefined
              }
            />
          ))
        )}
      </SettingsGroup>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add secret</DialogTitle>
          </DialogHeader>
          {creating && (
            <CredentialForm
              canCreateWorkspace={credentials.data?.can_create_workspace}
              onSaved={() => setCreating(false)}
              onCancel={() => setCreating(false)}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
      >
        <DialogContent className="max-h-screen overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{selected?.name}</DialogTitle>
          </DialogHeader>
          {selected && (
            <CredentialDetails
              key={selected.id}
              credential={selected}
              onClose={() => setSelected(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function CredentialDetails({
  credential,
  onClose,
}: {
  credential: Credential
  onClose: () => void
}) {
  const usage = useQuery(credentialUsageQuery(credential.id))
  const [replacing, setReplacing] = useState(false)
  const revoke = useApiMutation({
    mutationFn: () => api.revokeConnection(credential.id),
    invalidate: credentialInvalidations,
    onSuccess: onClose,
    success: "Secret revoked",
  })
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {credential.scope === "personal" ? "Personal secret" : "Workspace secret"} · Added{" "}
        {new Date(credential.created_at).toLocaleDateString()}
      </p>
      {usage.isError ? (
        <LoadError
          title="Couldn’t load where it is used"
          testId="credential-usage-retry"
          onRetry={() => void usage.refetch()}
        />
      ) : !usage.data ? (
        <p className="text-sm text-muted-foreground">Checking usage…</p>
      ) : (
        <>
          <div className="flex flex-col gap-2 text-sm">
            <p className="font-medium">Used by</p>
            {usage.data.items.length === 0 && usage.data.hidden_count === 0 && (
              <p className="text-muted-foreground">No current assignments.</p>
            )}
            {usage.data.items.map((item) => (
              <p key={item.id} data-testid={`credential-usage-${item.id}`}>
                {item.name}
              </p>
            ))}
            {usage.data.hidden_count > 0 && (
              <p className="text-muted-foreground">
                {usage.data.hidden_count} other assignment(s) you cannot view.
              </p>
            )}
          </div>
          {credential.status === "active" && (
            <>
              <p className="text-sm text-muted-foreground">
                Replacing keeps these assignments. Revoking blocks future retrieval. A job that is
                already running may still hold the old value.
              </p>
              {replacing ? (
                <CredentialForm
                  credential={credential}
                  onSaved={onClose}
                  onCancel={() => setReplacing(false)}
                />
              ) : (
                <div className="flex gap-2">
                  <Button
                    data-testid="credential-replace"
                    disabled={revoke.isPending}
                    onClick={() => setReplacing(true)}
                  >
                    Replace value
                  </Button>
                  <Button
                    data-testid="credential-revoke"
                    variant="destructive"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate()}
                  >
                    {revoke.isPending ? "Revoking…" : "Revoke secret"}
                  </Button>
                </div>
              )}
            </>
          )}
          {credential.status === "revoked" && (
            <p className="text-sm text-muted-foreground">
              This secret is revoked. Add a new one and assign it to restore access.
            </p>
          )}
        </>
      )}
    </div>
  )
}

import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { api, type Credential } from "@/api"
import { CredentialForm, credentialInvalidations } from "@/components/credentials/credential-form"
import { LoadError } from "@/components/shared/load-error"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { credentialsQuery, credentialUsageQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { SettingsSection } from "./settings-section"

export function CredentialsSection() {
  const credentials = useQuery(credentialsQuery())
  const [creating, setCreating] = useState(false)
  // Keep the version the user chose; a background refresh must not silently approve a newer value.
  const [selected, setSelected] = useState<Credential | null>(null)
  return (
    <SettingsSection
      title="Credentials"
      description="Save database passwords, API keys and other secrets for your workflows. Model accounts live in Accounts."
    >
      <div className="flex flex-col gap-4">
        {credentials.isError ? (
          <LoadError
            title="Couldn’t load credentials"
            testId="credentials-retry"
            onRetry={() => void credentials.refetch()}
          />
        ) : !credentials.data ? (
          <p className="text-sm text-muted-foreground">Loading credentials…</p>
        ) : (
          <>
            <Button
              data-testid="credentials-add"
              className="self-start"
              onClick={() => setCreating(true)}
            >
              Add credential
            </Button>
            {credentials.data.items.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No credentials yet. Add one here or while setting up a workflow.
              </p>
            )}
            {credentials.data.items.map((credential) => (
              <div
                key={credential.id}
                className="flex items-center justify-between gap-3 rounded-lg border p-4"
              >
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium">{credential.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {credential.scope === "personal" ? "Personal · you" : "Workspace"} ·{" "}
                    {credential.status === "active"
                      ? "Not checked"
                      : credential.status === "revoked"
                        ? "Revoked"
                        : "Pending"}
                  </p>
                </div>
                {credential.can_manage && (
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid={`credential-manage-${credential.id}`}
                    onClick={() => setSelected(credential)}
                  >
                    Manage
                  </Button>
                )}
              </div>
            ))}
          </>
        )}
      </div>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add credential</DialogTitle>
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
    </SettingsSection>
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
    success: "Credential revoked",
  })
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {credential.scope === "personal" ? "Personal credential" : "Workspace credential"} · Added{" "}
        {new Date(credential.created_at).toLocaleDateString()}
      </p>
      {usage.isError ? (
        <LoadError
          title="Couldn’t load affected workflows"
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
            {usage.data.items.map((item) =>
              item.kind === "workflow" ? (
                <Link
                  key={item.id}
                  to="/workflows"
                  search={{ workflow: item.id, tab: "configuration" }}
                  data-testid={`credential-usage-${item.id}`}
                  className="text-primary underline"
                >
                  {item.name}
                </Link>
              ) : item.kind === "context" ? (
                <Link
                  key={item.id}
                  to="/contexts/$id"
                  params={{ id: item.id }}
                  data-testid={`credential-usage-${item.id}`}
                  className="text-primary underline"
                >
                  {item.name}
                </Link>
              ) : (
                <p key={item.id}>{item.name}</p>
              ),
            )}
            {usage.data.hidden_count > 0 && (
              <p className="text-muted-foreground">
                {usage.data.hidden_count} other assignment(s) you cannot view.
              </p>
            )}
          </div>
          {credential.status === "active" && (
            <>
              <p className="text-sm text-muted-foreground">
                Replacing keeps these assignments. Revoking blocks future retrieval. Queued
                persistent runs need to be started again after either change. Already running
                processes may still hold the old value.
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
                    {revoke.isPending ? "Revoking…" : "Revoke credential"}
                  </Button>
                </div>
              )}
            </>
          )}
          {credential.status === "revoked" && (
            <p className="text-sm text-muted-foreground">
              This credential is revoked. Add a new credential and assign it to restore access.
            </p>
          )}
        </>
      )}
    </div>
  )
}

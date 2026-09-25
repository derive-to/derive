import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "@/api"
import { ModelAccountPicker } from "@/components/accounts/model-account-picker"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { LoadError } from "@/components/shared/load-error"
import { SectionTitle } from "@/components/shared/section-title"
import { Button } from "@/components/ui/button"
import {
  contextRuntimeQuery,
  runtimeModelBindingQuery,
  runtimeModelConnectionsQuery,
  workflowRuntimesQuery,
} from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"

export function RuntimeModelAccount({
  contextId,
  canEdit,
}: {
  contextId: string
  canEdit: boolean
}) {
  const binding = useQuery(runtimeModelBindingQuery(contextId))
  const accounts = useQuery({
    ...runtimeModelConnectionsQuery(),
    enabled: canEdit,
  })
  const [draft, setDraft] = useState<{ id: string; revision: number | null } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [confirmReplace, setConfirmReplace] = useState(false)
  const selected = binding.data?.connection
  const chosenId = draft?.id ?? selected?.id ?? ""
  const chosen = accounts.data?.items.find((item) => item.id === chosenId)
  const save = useApiMutation({
    mutationFn: (remove: boolean) =>
      api.setRuntimeModelBinding(
        contextId,
        remove ? null : chosenId,
        remove
          ? (binding.data?.revision ?? null)
          : draft
            ? draft.revision
            : (binding.data?.revision ?? null),
      ),
    invalidate: [
      runtimeModelBindingQuery(contextId).queryKey,
      contextRuntimeQuery(contextId).queryKey,
      workflowRuntimesQuery().queryKey,
      ["runtime-model-usage"],
    ],
    success: (_, remove) =>
      remove ? "This workflow’s account access was removed" : "Model account selected",
    onSuccess: () => setDraft(null),
  })
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-5">
      <SectionTitle>Model account</SectionTitle>
      {binding.isError && (
        <LoadError
          title="Could not load the workflow’s account"
          testId="context-model-binding-error"
          onRetry={() => binding.refetch()}
        />
      )}
      {!binding.isError && (
        <p className="text-sm">
          {binding.isPending
            ? "Loading model account…"
            : selected
              ? `${selected.name} · ${selected.provider === "codex" ? "Codex" : "Claude Code"}${selected.revoked ? " · Disconnected" : ""}`
              : "No account selected for this workflow."}
        </p>
      )}
      {canEdit && (
        <>
          <p className="text-sm text-muted-foreground">
            Choose one of your accounts to let authorized teammates run this workflow. Other
            workflows can use the same account while keeping separate files and tools. Changes take
            effect before the next run; active work using the previous selection stops.
          </p>
          <ModelAccountPicker
            value={chosenId}
            assigned={selected}
            disabled={!binding.data || save.isPending}
            onChange={(account) =>
              setDraft({ id: account.id, revision: binding.data?.revision ?? null })
            }
          />
          <div className="flex flex-wrap gap-2">
            <Button
              data-testid="context-model-account-use"
              disabled={!chosen || !!chosen.unavailable_reason || !draft || save.isPending}
              loading={save.isPending}
              onClick={() =>
                selected && selected.id !== chosenId ? setConfirmReplace(true) : save.mutate(false)
              }
            >
              Use this account
            </Button>
            {selected && (
              <Button
                data-testid="context-model-account-remove"
                variant="outline"
                disabled={save.isPending}
                onClick={() => setConfirmRemove(true)}
              >
                Remove this workflow’s access
              </Button>
            )}
          </div>
          <ConfirmDialog
            open={confirmReplace}
            onOpenChange={setConfirmReplace}
            title="Replace this workflow’s account?"
            description={`This workflow will use ${chosen?.name ?? "the selected account"}. Active work using ${selected?.name ?? "the previous account"} will stop. Other workflows keep their account assignments.`}
            confirmLabel="Replace account"
            onConfirm={() => save.mutateAsync(false).then(() => undefined)}
          />
          <ConfirmDialog
            open={confirmRemove}
            onOpenChange={setConfirmRemove}
            title="Remove this workflow’s account access?"
            description="Active work will stop and this workflow cannot run until an account is selected. Other workflows keep their access."
            confirmLabel="Remove access"
            onConfirm={() => save.mutateAsync(true).then(() => undefined)}
          />
        </>
      )}
    </div>
  )
}

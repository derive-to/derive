import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Plug } from "lucide-react"
import { useState } from "react"
import { api, type Connection } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { EmptyState } from "@/components/shared/empty-state"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { toast } from "@/components/ui/sonner"
import { connectionsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SettingsSection } from "./settings-section"

// WO3 — Sources: the caller's own connected external accounts. Connect a toolkit once (the
// broker authorizes it); a hosted run then reaches its tools. Each connection is bound to you
// and revocable here. Instructions name the tool in plain language — no wiring UI beyond this.
export function SourcesSection() {
  const qc = useQueryClient()
  const { data: connections, isPending, isError, refetch } = useQuery(connectionsQuery())
  const [toolkit, setToolkit] = useState("")
  const [revoking, setRevoking] = useState<Connection | null>(null)
  const reload = () => qc.invalidateQueries({ queryKey: connectionsQuery().queryKey })

  const connect = useApiMutation({
    mutationFn: (t: string) => api.connect(t),
    onSuccess: (c) => {
      setToolkit("")
      reload()
      // A pending connection returns an auth URL to open; an auto-authorized one is ready.
      if (c.status === "pending" && c.connect_url) window.open(c.connect_url, "_blank", "noopener")
      else toast.success(`Connected ${c.toolkit}`)
    },
  })
  const revoke = useApiMutation({
    mutationFn: (c: Connection) => api.revokeConnection(c.id),
    onSuccess: () => {
      setRevoking(null)
      reload()
      toast.success("Connection revoked")
    },
  })

  return (
    <SettingsSection
      title="Sources"
      description="Connect an account once; instructions can then name its tools in plain language. Each connection is yours and revocable."
    >
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (toolkit.trim()) connect.mutate(toolkit.trim().toLowerCase())
        }}
      >
        <Input
          value={toolkit}
          onChange={(e) => setToolkit(e.target.value)}
          placeholder="Toolkit (e.g. gmail, stripe, github)"
          aria-label="Toolkit to connect"
          data-testid="source-toolkit"
        />
        <Button
          type="submit"
          disabled={connect.isPending || !toolkit.trim()}
          data-testid="source-connect"
        >
          Connect
        </Button>
      </form>

      {isPending ? (
        <SettingsListSkeleton />
      ) : isError ? (
        <StatusPanel
          tone="danger"
          title="Couldn't load your sources"
          description="This is usually temporary."
          action={
            <Button
              variant="outline"
              size="sm"
              data-testid="sources-retry"
              onClick={() => refetch()}
            >
              Try again
            </Button>
          }
        />
      ) : !connections || connections.length === 0 ? (
        <EmptyState>No sources yet. Connect a toolkit to give hosted runs hands.</EmptyState>
      ) : (
        <SettingsGroup>
          {connections.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between gap-3 px-3 py-2.5"
              data-testid={`source-${c.id}`}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <Plug className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="truncate font-medium text-sm">{c.toolkit}</div>
                  <div className="truncate text-2xs text-muted-foreground">
                    {c.broker}
                    {c.scopes_label ? ` · ${c.scopes_label}` : ""}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant={c.status === "active" ? "secondary" : "outline"}>{c.status}</Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setRevoking(c)}
                  data-testid={`source-revoke-${c.id}`}
                >
                  Revoke
                </Button>
              </div>
            </div>
          ))}
        </SettingsGroup>
      )}

      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => {
          if (!o) setRevoking(null)
        }}
        title={`Revoke ${revoking?.toolkit ?? "connection"}?`}
        description="Hosted runs will lose access to this account's tools. You can reconnect later."
        confirmLabel="Revoke"
        tone="destructive"
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking)
        }}
      />
    </SettingsSection>
  )
}

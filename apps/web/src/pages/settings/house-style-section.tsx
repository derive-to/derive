import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { api, type Collection, type HouseStyle } from "@/api"
import { Spinner } from "@/components/shared/spinner"
import { Card } from "@/components/ui/card"

/**
 * Pick the conventions collection that defines "how we build things" here. Agents
 * connected to this workspace read those docs as House Style context (over MCP); your
 * personal choice (scope="profile") layers on top. Workspace scope saves to the
 * workspace settings, profile scope to your account. Theme tokens are Phase B.
 */
export function HouseStyleSection({ scope }: { scope: "workspace" | "profile" }) {
  const [collections, setCollections] = useState<Collection[] | null>(null)
  const [collectionId, setCollectionId] = useState<string>("")
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    api
      .listCollections()
      .then((r) => setCollections(r.collections))
      .catch(() => setCollections([]))
    if (scope === "workspace") {
      api
        .getWorkspaceSettings()
        .then((s) => setCollectionId(s.houseStyle?.collectionId ?? ""))
        .catch(() => setCollectionId(""))
    } else {
      api
        .me()
        .then(({ user }) => {
          try {
            const hs = user.houseStyle ? (JSON.parse(user.houseStyle) as HouseStyle) : null
            setCollectionId(hs?.collectionId ?? "")
          } catch {
            setCollectionId("")
          }
        })
        .catch(() => setCollectionId(""))
    }
  }, [scope])
  useEffect(() => load(), [load])

  const save = async (next: string) => {
    setCollectionId(next)
    setSaving(true)
    try {
      const houseStyle: HouseStyle = { collectionId: next || null }
      if (scope === "workspace") await api.updateWorkspaceSettings({ houseStyle })
      else await api.setProfile({ houseStyle: next ? houseStyle : null })
      toast.success("House Style updated")
    } catch (e) {
      toast.error((e as Error).message)
      load()
    } finally {
      setSaving(false)
    }
  }

  const title = scope === "workspace" ? "Workspace House Style" : "Your House Style"
  const hint =
    scope === "workspace"
      ? "The conventions collection agents read before building artifacts here."
      : "Your personal conventions — layered over the workspace's (yours wins)."

  return (
    <Card className="p-4">
      <div className="text-sm font-medium">{title}</div>
      <div className="mb-3 text-sm text-muted-foreground">{hint}</div>
      {collections === null ? (
        <Spinner />
      ) : (
        <label className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">Conventions collection</span>
          <select
            data-testid={`house-style-collection-${scope}`}
            value={collectionId}
            disabled={saving}
            onChange={(e) => save(e.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1.5 text-sm disabled:opacity-50"
          >
            <option value="">None</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </label>
      )}
    </Card>
  )
}

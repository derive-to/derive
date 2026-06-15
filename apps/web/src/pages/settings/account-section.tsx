import { useState } from "react"
import { api } from "@/api"
import { Card } from "@/components/ui/card"
import { useAuth } from "@/ctx"

// Personal account settings (vs the workspace tab). Today: discoverability —
// on by default (GitHub-style), uncheck to hide yourself from people search.
export function AccountSection() {
  const { me, setMe } = useAuth()
  const [discoverable, setDiscoverable] = useState(!!me?.discoverable)
  if (!me) return null

  const toggle = async () => {
    const next = !discoverable
    setDiscoverable(next) // optimistic
    try {
      await api.setDiscoverable(next)
      setMe({ ...me, discoverable: next })
    } catch {
      setDiscoverable(!next)
    }
  }

  return (
    <Card className="p-4">
      <h3 className="font-display text-sm font-semibold">Discoverability</h3>
      <label className="mt-2.5 flex cursor-pointer items-start gap-2.5 text-sm text-foreground">
        <input
          type="checkbox"
          data-testid="account-discoverable"
          checked={discoverable}
          onChange={toggle}
          className="mt-0.5 size-4"
        />
        <span>
          Let people find me by username in search.
          <span className="mt-0.5 block text-xs text-muted-foreground">
            On by default. Your @{me.username ?? "handle"}, name, and photo show up in people
            search; uncheck to hide yourself. Your email always stays private.
          </span>
        </span>
      </label>
    </Card>
  )
}

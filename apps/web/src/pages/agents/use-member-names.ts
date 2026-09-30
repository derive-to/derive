import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import { workspaceQuery } from "@/lib/queries"

/** Member id → display name, for who asked and whose machine an agent runs on. A failed
 *  roster read degrades to no names; the screens still say what they can without them. */
export function useMemberNames(): Map<string, string> {
  const { data } = useQuery(workspaceQuery())
  return useMemo(
    () => new Map((data?.members ?? []).map((m) => [m.user_id, m.name ?? m.handle ?? ""])),
    [data],
  )
}

import { useQuery } from "@tanstack/react-query"
import { useId, useState } from "react"
import { workspaceDisplayName } from "@/api"
import { useCopy } from "@/lib/clipboard"
import { workspacesQuery } from "@/lib/queries"
import { type AgentTemplateTarget, localAgentHandoff } from "./agent-handoff"

export function useAgentTemplateHandoff(target: AgentTemplateTarget) {
  const [brief, setBrief] = useState("")
  const [error, setError] = useState("")
  const [showHandoff, setShowHandoff] = useState(false)
  const { copied, copy } = useCopy(4000)
  const descriptionId = useId()
  const workspacesState = useQuery(workspacesQuery())
  const activeWorkspaceSummary = workspacesState.data?.workspaces.find(
    (workspace) => workspace.id === workspacesState.data.active,
  )
  const activeWorkspace = activeWorkspaceSummary
    ? {
        id: activeWorkspaceSummary.id,
        name: workspaceDisplayName(activeWorkspaceSummary),
      }
    : undefined
  const handoff = localAgentHandoff(target, brief, activeWorkspace)

  const copyForLocalAgent = async () => {
    if (!brief.trim()) return
    setError("")
    const ok = await copy(handoff, {
      success: "Copied — paste it into your agent",
      error: null,
    })
    if (!ok) {
      setShowHandoff(true)
      setError("Clipboard access was blocked. Select the handoff below and copy it manually.")
    }
  }

  return {
    brief,
    setBrief,
    error,
    showHandoff,
    copied,
    descriptionId,
    handoff,
    copyForLocalAgent,
  }
}

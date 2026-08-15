import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useId, useRef, useState } from "react"
import { ApiError, api, workspaceDisplayName } from "@/api"
import { useCopy } from "@/lib/clipboard"
import {
  connectedAgentsQuery,
  contextSessionsQuery,
  contextsQuery,
  workspacesQuery,
} from "@/lib/queries"
import { runnerStatus } from "@/pages/context/runner-status"
import { type AgentTemplateTarget, localAgentHandoff } from "./agent-handoff"

export function useAgentTemplateHandoff(
  target: AgentTemplateTarget,
  onOpenChange: (open: boolean) => void,
) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [brief, setBrief] = useState("")
  const [dispatching, setDispatching] = useState(false)
  const [error, setError] = useState("")
  const [planRequired, setPlanRequired] = useState(false)
  const [showHandoff, setShowHandoff] = useState(false)
  const [selectedContext, setSelectedContext] = useState("")
  const { copied, copy } = useCopy(4000)
  const mounted = useRef(true)
  const descriptionId = useId()
  const contextsState = useQuery(contextsQuery())
  const connectedAgentsState = useQuery(connectedAgentsQuery())
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
  const onlineContexts = (contextsState.data ?? []).filter(
    (context) => runnerStatus(context.runner_seen_at).online,
  )
  const selectedRunner =
    onlineContexts.find((context) => context.id === selectedContext) ?? onlineContexts[0] ?? null
  const busy = dispatching
  const handoff = localAgentHandoff(target, brief, activeWorkspace)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (onlineContexts.length && !onlineContexts.some((context) => context.id === selectedContext))
      setSelectedContext(onlineContexts[0]?.id ?? "")
  }, [onlineContexts, selectedContext])

  const copyForLocalAgent = async () => {
    if (!brief.trim() || busy) return
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

  const runOnConnectedMachine = async () => {
    if (!brief.trim() || !selectedRunner || busy) return
    setDispatching(true)
    setError("")
    setPlanRequired(false)
    try {
      await api.askContext(selectedRunner.id, handoff)
      if (!mounted.current) return
      await queryClient.invalidateQueries({
        queryKey: contextSessionsQuery(selectedRunner.id).queryKey,
      })
      onOpenChange(false)
      await navigate({ to: "/contexts/$id", params: { id: selectedRunner.id } })
    } catch (cause) {
      if (!mounted.current) return
      if (cause instanceof ApiError && cause.status === 402) {
        setPlanRequired(true)
        return
      }
      setError(
        cause instanceof Error
          ? cause.message
          : `Derive couldn’t send this to ${selectedRunner.name}. Please try again.`,
      )
    } finally {
      if (mounted.current) setDispatching(false)
    }
  }

  return {
    brief,
    setBrief,
    busy,
    dispatching,
    error,
    planRequired,
    showHandoff,
    setSelectedContext,
    copied,
    descriptionId,
    contextsState,
    connectedAgentsState,
    onlineContexts,
    selectedRunner,
    activeWorkspace,
    handoff,
    copyForLocalAgent,
    runOnConnectedMachine,
    openModelPlans: () => {
      onOpenChange(false)
      void navigate({ to: "/settings/$section", params: { section: "model-plans" } })
    },
  }
}

import { createFileRoute } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"
import { AgentBuilderPage } from "../pages/context/builder"

export const Route = createFileRoute("/agents/new")({
  beforeLoad: requireOnboarded,
  component: AgentBuilderPage,
})

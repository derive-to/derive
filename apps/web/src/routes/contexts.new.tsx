import { createFileRoute } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"
import { ContextBuilderPage } from "../pages/context/builder"

export const Route = createFileRoute("/contexts/new")({
  beforeLoad: requireOnboarded,
  component: ContextBuilderPage,
})

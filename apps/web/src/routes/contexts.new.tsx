import { createFileRoute } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"
import { ContextBuilderPage } from "../pages/context/builder"

// The guided context-builder conversation: /contexts/new — the front door for creating
// a context. Same beforeLoad as every other in-app route; no loader, mirroring /chat
// (this page's own two queries — workspace, chat models — degrade in-component rather
// than blanking the route on a cold-load race).
export const Route = createFileRoute("/contexts/new")({
  beforeLoad: requireOnboarded,
  component: ContextBuilderPage,
})

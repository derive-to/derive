import { createFileRoute, redirect } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"

// Preserve the legacy creation URL without maintaining two builder routes.
export const Route = createFileRoute("/contexts/new")({
  beforeLoad: async (args) => {
    await requireOnboarded(args)
    throw redirect({ to: "/agents/new", replace: true })
  },
})

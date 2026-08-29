import { createFileRoute, redirect } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"

export const Route = createFileRoute("/agents/new")({
  beforeLoad: async (args) => {
    await requireOnboarded(args)
    throw redirect({ to: "/contexts/new", replace: true })
  },
})

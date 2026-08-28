import { createFileRoute, redirect } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"

export const Route = createFileRoute("/agents/$id")({
  beforeLoad: async (args) => {
    await requireOnboarded(args)
    throw redirect({ to: "/contexts/$id", params: { id: args.params.id }, replace: true })
  },
})

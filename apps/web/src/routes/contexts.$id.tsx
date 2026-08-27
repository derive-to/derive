import { createFileRoute, redirect } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"

// Context ids remain stable; only the public route vocabulary changes.
export const Route = createFileRoute("/contexts/$id")({
  beforeLoad: async (args) => {
    await requireOnboarded(args)
    throw redirect({ to: "/agents/$id", params: { id: args.params.id }, replace: true })
  },
})

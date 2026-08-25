import { createFileRoute, redirect } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"

// Compatibility for old links. Contexts now live inside the Workflows directory;
// their detail and builder URLs remain stable.
export const Route = createFileRoute("/contexts/")({
  beforeLoad: async (args) => {
    await requireOnboarded(args)
    throw redirect({ to: "/workflows", search: { view: "contexts" }, replace: true })
  },
})

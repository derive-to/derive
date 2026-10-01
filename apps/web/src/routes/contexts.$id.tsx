import { createFileRoute, redirect } from "@tanstack/react-router"
import { paperQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"

// Old /contexts/<id> bookmarks. The only Contexts left are imported papers, which live at
// /papers/<id>; any other id lands on the Agents home, where the rest of that work moved.
export const Route = createFileRoute("/contexts/$id")({
  beforeLoad: async (args) => {
    await requireOnboarded(args)
    const paper = await args.context.queryClient
      .ensureQueryData(paperQuery(args.params.id))
      .catch(() => null)
    if (paper?.import)
      throw redirect({ to: "/papers/$id", params: { id: args.params.id }, replace: true })
    throw redirect({ to: "/agents", replace: true })
  },
})

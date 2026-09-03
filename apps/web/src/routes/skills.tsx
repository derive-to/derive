import { createFileRoute } from "@tanstack/react-router"
import { bootstrapQuery } from "../lib/bootstrap"
import { skillsQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import { Skills, SkillsPending } from "../pages/skills"

export const Route = createFileRoute("/skills")({
  beforeLoad: requireOnboarded,
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(bootstrapQuery(context.queryClient)).catch(() => {}),
      context.queryClient.ensureQueryData(skillsQuery()).catch(() => {}),
    ]),
  pendingComponent: SkillsPending,
  component: Skills,
})

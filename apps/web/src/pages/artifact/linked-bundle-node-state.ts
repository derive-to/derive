import type { LinkedBundleDiagramNode } from "./linked-bundle-node-details"

export const linkedBundleNodeStateDot = (state?: LinkedBundleDiagramNode["state"]): string => {
  if (state === "done") return "bg-success"
  if (state === "active") return "bg-insights"
  if (state === "waiting") return "bg-warning"
  if (state === "blocked") return "bg-destructive"
  return "bg-muted-foreground/60"
}

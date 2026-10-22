import type { Agent, Job } from "@/api"

/** Mirrors @derive/core machineHoldsCompute (the web imports core types only). */
const holdsCompute = (phase: string | null | undefined) =>
  !!phase && phase !== "released" && phase !== "parked"

export function taskStatus(job: Job, agent: Agent): string {
  const stopping = holdsCompute(job.machine_phase)
  if (job.status === "succeeded") return stopping ? "Result ready · stopping compute…" : "Done"
  if (job.status === "needs_you") return stopping ? "Needs you · stopping compute…" : "Needs you"
  if (job.status === "failed" || job.status === "lost")
    return stopping ? "Failed · stopping compute…" : "Failed"
  if (job.status === "cancelled") return stopping ? "Stopping compute…" : "Stopped"
  if (job.status === "queued" && job.machine_phase === "parked") return "Resuming"
  if (job.status === "queued") {
    if (agent.paused) return "Paused"
    if (["creating", "provisioning", "stopping"].includes(agent.runtime?.phase ?? ""))
      return "Getting ready"
    if (agent.runtime?.phase === "failed") return "Retrying setup"
    return "Waiting"
  }
  if (["creating", "provisioning", "starting"].includes(job.machine_phase ?? "")) return "Starting"
  if (job.machine_phase === "stopping") return "Saving files"
  return job.task.session ? "Session open" : "Running"
}

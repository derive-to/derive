/** Server-verified repository grants. No GitHub credential is persisted here. */
export interface WorkflowRepository {
  connection_id: string
  installation_id: string
  repository_id: number
  repository: string
  access: "read" | "write"
}
export const WORKFLOW_REPOSITORY_LIMIT = 10
export const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/

/** Strict decoding also protects admission through non-HTTP store callers. */
export function workflowRepositories(value: unknown): WorkflowRepository[] {
  if (!Array.isArray(value) || value.length > WORKFLOW_REPOSITORY_LIMIT)
    throw new Error("Choose at most ten repositories")
  const ids = new Set<number>()
  const names = new Set<string>()
  return value.map((r) => {
    if (
      !r ||
      typeof r !== "object" ||
      typeof r.connection_id !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(r.connection_id) ||
      typeof r.installation_id !== "string" ||
      !/^[1-9][0-9]*$/.test(r.installation_id) ||
      !Number.isSafeInteger(r.repository_id) ||
      r.repository_id < 1 ||
      typeof r.repository !== "string" ||
      !GITHUB_REPOSITORY_PATTERN.test(r.repository) ||
      r.repository.split("/").some((p: string) => p === "." || p === "..") ||
      !["read", "write"].includes(r.access) ||
      ids.has(r.repository_id) ||
      names.has(r.repository.toLowerCase())
    )
      throw new Error("Invalid or duplicate workflow repository")
    ids.add(r.repository_id)
    names.add(r.repository.toLowerCase())
    return {
      connection_id: r.connection_id,
      installation_id: r.installation_id,
      repository_id: r.repository_id,
      repository: r.repository,
      access: r.access,
    }
  })
}
export function readWorkflowRepositories(raw: string | null): WorkflowRepository[] {
  return workflowRepositories(JSON.parse(raw ?? "[]"))
}

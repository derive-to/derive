/** Only task configuration lives here. Accounts, access, files and schedules keep their existing owners. */
export interface WorkflowDraftRecord {
  context_id: string
  org_id: string
  sealed_at: string | null
  instruction: string
  provider: "codex" | "claude-code"
  revision: number
  updated_at: string
}
export interface WorkflowTestRecord {
  id: string
  context_id: string
  org_id: string
  initiated_by: string
  config_revision: string
  input_snapshot: string
  status: "pending" | "submitted" | "failed"
  created_at: string
}
export interface WorkflowReadiness {
  state: "draft" | "needs_account" | "needs_access" | "preparing" | "ready" | "needs_attention"
  revision: string
  evaluated_at: string
  blockers: {
    code: string
    message: string
    action: "edit" | "files" | "account" | "access" | "settings" | "retry" | null
  }[]
  can_edit: boolean
  can_test: boolean
}

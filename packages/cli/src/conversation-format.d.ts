export declare const RUNNER_PROTOCOL_VERSION: 1
export interface ConversationCheckpoint {
  version: 1
  provider: "codex" | "claude-code"
  session_id: string
  sha256: string
  files: Record<string, string>
}
export declare function checkpointFileAllowed(
  provider: string,
  session: string,
  file: string,
): boolean
export declare function checkpointProblem(value: ConversationCheckpoint): string | null

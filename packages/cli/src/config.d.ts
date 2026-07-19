// Hand-written declarations for config.js (plain JS by convention — this package
// doesn't typecheck). Kept in lockstep with the exports below; this is what
// @derive-to/mcp imports for a typed view of the shared local credential store.

export declare const CONFIG_FILE: "derive.json"
export declare const CLOUD_SERVER: "https://derive.to"
export declare const LOCAL_SERVER: "http://localhost:8080"

export interface DeriveConfig {
  $schema?: string
  title?: string
  entry?: string
  visibility?: "public" | "link" | "org" | "password" | "private"
  spa?: boolean
  id?: string | null
  server?: string
  workspace?: string
  account?: string
}

export declare function resolveServer(
  opts?: { server?: string; local?: boolean },
  config?: DeriveConfig | null,
): string

// ---- Credential store --------------------------------------------------------

export interface AuthGrant {
  token: string
  refresh_token: string | null
  client_id: string | null
  expires_at: string | null
  saved_at: string | null
}

export interface WorkspaceInfo {
  name: string
  role: string
  description?: string
}

export interface AccountRecord {
  handle: string | null
  auth: AuthGrant | null
  workspaces: Record<string, WorkspaceInfo>
  defaultWorkspace: string | null
}

export interface CredentialsEntry {
  client_id: string | null
  defaultAccount: string | null
  accounts: Record<string, AccountRecord>
}

export declare function loadCredentials(): Record<string, unknown>
export declare function entryFor(server: string): CredentialsEntry

export declare function getClientId(server: string): string | null
export declare function saveClientId(server: string, clientId: string): string

export interface AuthGrantInput {
  token: string
  refresh_token?: string | null
  client_id?: string | null
  expires_in?: number | null
}

export declare function saveAccount(
  server: string,
  accountId: string,
  patch?: { handle?: string | null; grant?: AuthGrantInput },
): string

export interface WorkspaceDiffEntry {
  id: string
  name: string
}
export interface WorkspaceRenamed {
  id: string
  from: string
  to: string
}
export interface WorkspaceDiff {
  added: WorkspaceDiffEntry[]
  renamed: WorkspaceRenamed[]
  removed: WorkspaceDiffEntry[]
}

export declare function setWorkspaces(
  server: string,
  accountId: string,
  workspacesMap: Record<string, WorkspaceInfo>,
): WorkspaceDiff

export declare function mergeChosenWorkspaces(
  existing: Record<string, WorkspaceInfo>,
  chosen: Record<string, WorkspaceInfo>,
  narrowing: boolean,
): Record<string, WorkspaceInfo>

export interface AccountSummary {
  id: string
  handle: string | null
  workspaceCount: number
  isDefault: boolean
}
export declare function listAccounts(server: string): AccountSummary[]
export declare function getAccount(server: string, accountId: string): AccountRecord | null
export declare function resolveAccountRef(server: string, ref: string): string | null
export declare function findAccountWorkspace(
  server: string,
  accountId: string,
  ref: string,
): WorkspaceRef | null

export interface DefaultTarget {
  account: string
  workspace: string | null
}
export declare function getDefault(server: string): DefaultTarget | null
export declare function setDefaultAccount(server: string, accountId: string): void

export interface WorkspaceRef {
  id: string
  name: string
}
export declare function setDefaultWorkspace(
  server: string,
  accountId: string,
  ref: string,
): WorkspaceRef
export declare function forgetWorkspace(
  server: string,
  accountId: string,
  ref: string,
): WorkspaceRef | null
export declare function describeWorkspace(
  server: string,
  accountId: string,
  ref: string,
  description: string | null,
): WorkspaceRef
export declare function removeAccount(server: string, accountId: string): boolean

export interface WorkspaceRefResolved {
  accountId: string
  workspaceId: string
  workspaceName: string
}
export interface WorkspaceRefAmbiguous {
  ambiguous: { accountId: string; handle: string | null }[]
}
export declare function resolveWorkspaceRef(
  server: string,
  ref: string,
): WorkspaceRefResolved | WorkspaceRefAmbiguous | null

export declare function freshToken(server: string, accountId: string | null): Promise<string | null>

// ---- Project scaffold + publish resolution -----------------------------------

export declare function defaultConfig(title?: string, entry?: string): DeriveConfig
export declare const TEMPLATES: string[]
export declare function loadConfig(dir?: string): DeriveConfig | null

export type WorkspaceError =
  | { type: "not_found"; ref: string }
  | { type: "no_account"; ref: string }
  | { type: "ambiguous"; ref: string; accounts: { accountId: string; handle: string | null }[] }

export interface ResolvedPublish {
  id: string | null
  target: string | null
  title?: string
  slug?: string
  visibility?: string
  spa: boolean
  message?: string
  name?: string
  server: string
  accountId: string | null
  accountHandle: string | null
  workspaceId: string | null
  workspaceName: string | null
  workspaceError: WorkspaceError | null
  token: string | null
}
export declare function resolvePublish(
  opts?: Record<string, unknown>,
  config?: DeriveConfig | null,
): ResolvedPublish

export declare function writeId(dir: string, id: string): DeriveConfig
export declare function agentScaffoldFiles(): Record<string, string>
export declare function scaffoldFiles(title?: string, template?: string): Record<string, string>
export declare const DERIVE_SCHEMA: Record<string, unknown>

export interface CommentLike {
  id: string
  thread_id: string
  author: string
  body_md: string
  state?: string
  anchor?: string | null
}
export declare function formatComments(comments: CommentLike[] | null | undefined): string
export declare function scaffold(
  dir?: string,
  title?: string,
  template?: string,
): { created: string[]; skipped: string[] }
export declare function scaffoldAgent(dir?: string): { created: string[]; skipped: string[] }

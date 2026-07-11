// Hand-written declarations for publish.js (plain JS by convention — this package
// doesn't typecheck). Kept in lockstep with the exports below; this is what
// @derive-to/mcp imports for a typed view of the shared publish-request builder.

export interface DocEdit {
  old_str: string
  new_str: string
}

export interface PublishFormFields {
  bytes?: Uint8Array
  filename?: string
  /** Surgical revision, no file upload — mutually exclusive with `bytes`. */
  edits?: DocEdit[]
  baseVersion?: number
  title?: string
  slug?: string
  spa?: boolean
  message?: string
  name?: string
  workspaceAccess?: "none" | "member"
  linkRole?: "none" | "viewer" | "commenter" | "editor"
  listed?: "none" | "workspace" | "public"
  /** Legacy pre-v2 alias; an explicit access field above wins server-side. */
  visibility?: "public" | "link" | "org" | "password" | "private"
  password?: string
  resolves?: string[]
  requestReview?: boolean
  /** Escape hatch for one-off form fields without a dedicated parameter. */
  extra?: Record<string, string>
}

export declare function buildPublishForm(fields: PublishFormFields): FormData

export interface UploadTarget {
  server: string
  token?: string
  workspaceId?: string
  id?: string
  title?: string
  slug?: string
  spa?: boolean
  message?: string
  name?: string
  workspaceAccess?: PublishFormFields["workspaceAccess"]
  linkRole?: PublishFormFields["linkRole"]
  listed?: PublishFormFields["listed"]
  visibility?: PublishFormFields["visibility"]
  password?: string
}

export declare function uploadArtifact(
  p: UploadTarget,
  bytes: Uint8Array,
  filename: string,
  extra?: Record<string, string>,
): Promise<{ res: Response; json: unknown }>

export declare function collectDir(
  dir: string,
  base?: string,
  out?: { files: Record<string, Uint8Array>; skipped: string[] },
  skipTopDirs?: string[],
): { files: Record<string, Uint8Array>; skipped: string[] }

export declare function readTarget(
  target: string,
  skipTopDirs?: string[],
): { bytes: Uint8Array; filename: string; skipped: string[] }

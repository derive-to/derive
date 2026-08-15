import type { TemplateLibraryRecord } from "@derive/core"

/**
 * One access rule for authored template libraries, shared by HTTP and MCP.
 *
 * `workspaceReachable` means the caller's grant/session reaches this exact
 * workspace and `isMember` is their live membership there. Public libraries do
 * not need either. An operator token is deliberately instance-wide.
 */
export const canReadTemplateLibrary = (
  library: TemplateLibraryRecord,
  access: {
    ownerId: string | null
    workspaceReachable: boolean
    isMember: boolean
    isOperator?: boolean
  },
): boolean =>
  library.scope === "public" ||
  access.isOperator === true ||
  (access.workspaceReachable &&
    access.isMember &&
    (library.scope === "workspace" || library.created_by === access.ownerId))

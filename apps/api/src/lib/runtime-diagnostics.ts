/** Only fixed categories may leave the controller. Driver errors can contain SQL,
 * bound task instructions, or credentials, including inside nested causes. */
export function runtimeFailureReason(error: unknown): string {
  for (let depth = 0; depth < 4 && error && typeof error === "object"; depth++) {
    const e = error as { code?: unknown; cause?: unknown; message?: unknown }
    switch (e.code) {
      case "23505":
      case "SQLITE_CONSTRAINT_UNIQUE":
        return "duplicate"
      case "23503":
      case "SQLITE_CONSTRAINT_FOREIGNKEY":
        return "foreign_key"
      case "42P01":
      case "42703":
        return "schema"
      case "42501":
        return "database_permission"
      case "57014":
      case "ETIMEDOUT":
        return "timeout"
      case "ECONNRESET":
      case "ECONNREFUSED":
        return "connection"
    }
    if (e.message === "Runtime or pinned Context is unavailable to this run")
      return "admission_conflict"
    error = e.cause
  }
  return "unknown"
}

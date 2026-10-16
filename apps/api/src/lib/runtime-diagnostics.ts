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
    // Ortam's answer, never its body: an HTTP status with the endpoint's first segment
    // (lib/ortam-client.ts OrtamHttpError), a response that failed its schema, or one of the
    // client's own fixed messages ("Ortam request outcome is unknown"). None carries a value.
    const path = (e as { path?: unknown }).path
    if (typeof (e as { status?: unknown }).status === "number" && typeof path === "string")
      return `ortam_http_${(e as { status: number }).status} /${path.split(/[/?]/)[1] ?? ""}`
    if ((e as { name?: unknown }).name === "ZodError") return "unexpected_response_shape"
    if (typeof e.message === "string" && /^boat\.dev returned HTTP \d{3}$/.test(e.message))
      return e.message
    if (typeof e.message === "string" && /^boat\.dev [A-Za-z ]+$/.test(e.message)) return e.message
    if (typeof e.message === "string" && /^Ortam [A-Za-z ./()-]+$/.test(e.message)) return e.message
    error = e.cause
  }
  return "unknown"
}

// Terminal control sequences (ESC [ ... final byte), built so the escape byte stays out of source.
const ANSI = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "g")
// What a runner's output may carry: URL userinfo, env-style assignments of secrets, the token
// shapes Derive and the harnesses use, JWTs, and any long opaque string.
const SECRETS: Array<[RegExp, string]> = [
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s@]+@/gi, "$1[redacted]@"],
  [
    /([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CREDENTIALS?)[A-Za-z0-9_]*\s*[=:]\s*)\S+/gi,
    "$1[redacted]",
  ],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "[redacted]"],
  [/\bdk[a-z]*_[A-Za-z0-9_]{8,}/g, "[redacted]"],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\b[A-Fa-f0-9]{32,}\b/g, "[redacted]"],
  [/[A-Za-z0-9+/_-]{40,}={0,2}/g, "[redacted]"],
]

/** The end of a runner's output, fit for a failure a person reads: control sequences gone,
 *  lines joined, anything shaped like a credential replaced, and at most `max` characters,
 *  keeping the end. Null when nothing readable is left. */
export function redactedOutputTail(text: string | null | undefined, max = 400): string | null {
  if (!text) return null
  let out = text.replace(ANSI, "")
  for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement)
  out = out
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" | ")
  if (!out) return null
  return out.length > max ? `\u2026${out.slice(out.length - max + 1)}` : out
}

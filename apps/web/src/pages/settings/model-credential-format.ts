import type { ModelCredentialHint } from "@/api"

/**
 * Login credentials are subscription auth documents, not opaque strings. Older rows may
 * still carry the document's trailing punctuation as their hint, so never render it.
 */
export function credentialHintLabel(credential: ModelCredentialHint): string {
  return credential.kind === "login" ? "subscription" : `••••${credential.hint}`
}

import { passkeyClient } from "@better-auth/passkey/client"
import { createAuthClient } from "better-auth/client"

// A SCOPED Better Auth browser client — used ONLY for the ceremonies that genuinely need
// it: the WebAuthn passkey dance (navigator.credentials.*) and passkey management. Every
// other auth call stays on the hand-rolled `f()` wrapper in api.ts, and TanStack Query
// remains the single state system (we never use this client's nanostore session store).
//
// baseURL is left to default (same-origin `/api/auth`); the dev proxy + the hosted split
// both route `/api/auth/*` to the API, and credentials ride cookies like every other call.
export const authClient = createAuthClient({
  plugins: [passkeyClient()],
})

/** A registered passkey, as returned by listUserPasskeys (the Security-hub list). */
export interface PasskeySummary {
  id: string
  name?: string | null
  createdAt: string | Date
  deviceType?: string | null
}

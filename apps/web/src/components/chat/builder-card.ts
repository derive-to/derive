// The card meta the guided context-builder writes onto an agent message — routes/contexts.ts's
// SessionMeta.card, populated from lib/context-builder-tools.ts's BuilderCard on the server.
// Aliased from the generated OpenAPI types (api-types.ts, via api.ts's SessionMeta export)
// rather than redeclared here: one source of truth, so a server-side shape change fails
// typecheck at this file instead of silently drifting from what the API actually sends.
import type { SessionMeta } from "@/api"

export type BuilderCardMeta = NonNullable<NonNullable<SessionMeta>["card"]>

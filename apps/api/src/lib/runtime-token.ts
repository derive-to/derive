import { signCapabilityToken, verifyCapabilityToken } from "./capability-token"

const DOMAIN = "derive-runtime-attempt:"
const PREFIX = "dkattempt_"

// Deliberately not a WorkKind: these tokens never resolve to a general agent principal.
export const signRuntimeToken = async (
  secret: string,
  id: string,
  orgId: string,
  expires: number,
) => PREFIX + (await signCapabilityToken(DOMAIN, secret, [id, orgId], expires))

export async function verifyRuntimeToken(secret: string, token: string, now: number) {
  if (!token.startsWith(PREFIX)) return null
  const claim = await verifyCapabilityToken(DOMAIN, secret, token.slice(PREFIX.length), now)
  const fields = claim?.rest.split(".")
  return fields?.length === 2 && fields[0] && fields[1] ? { id: fields[0], orgId: fields[1] } : null
}

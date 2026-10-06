// Hand-written declarations for secrets.js (plain JS by convention; this package doesn't
// typecheck). The API tests drive these functions against the real app.

export interface SecretsClient {
  server: string
  headers: Record<string, string>
  fetch: (url: string, init?: RequestInit) => Promise<Response>
}

export declare const ENV_NAME: RegExp

export declare function putSecret(
  client: SecretsClient,
  opts: { name: string; value: string; workspace?: boolean; fresh?: boolean },
): Promise<{ id: string; name: string; reused: boolean }>

export declare function attachSecret(
  client: SecretsClient,
  opts: { agentId: string; variable: string; secretId: string },
): Promise<{ agent: string }>

export declare function listSecrets(
  client: SecretsClient,
): Promise<{ id: string; name: string; scope: string; status: string; canUse: boolean }[]>

export declare function readSecretValue(io?: {
  stdin?: NodeJS.ReadStream
  stderr?: NodeJS.WriteStream
}): Promise<string>

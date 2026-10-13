export type SessionApi = (
  path: string,
  init?: { method?: string; body?: unknown },
) => Promise<unknown>
export declare function sessionApi(opts: {
  server: string
  token: string | null
  workspaceId: string | null
  fetcher?: typeof fetch | ((url: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
}): SessionApi
export declare function sessionCommand(
  cmd: string,
  positional: string[],
  flags: Record<string, string | undefined>,
  api: SessionApi,
  opts?: { log?: (line: string) => void },
): Promise<number>
export declare function hereRepo(
  cwd?: string,
  git?: (cwd: string, args: string[]) => string,
): string

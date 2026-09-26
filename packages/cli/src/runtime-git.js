import { fileURLToPath } from "node:url"

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`

/** Process-only Git configuration. Snapshots retain clean HTTPS remotes, never these tokens. */
export function configureRuntimeGit(env) {
  for (const key of Object.keys(env)) if (key.startsWith("GIT_CONFIG_")) delete env[key]
  env.GIT_TERMINAL_PROMPT = "0"
  env.GIT_CONFIG_COUNT = "3"
  // Empty helper resets helpers inherited from system/global/repository configuration.
  env.GIT_CONFIG_KEY_0 = "credential.helper"
  env.GIT_CONFIG_VALUE_0 = ""
  env.GIT_CONFIG_KEY_1 = "credential.helper"
  env.GIT_CONFIG_VALUE_1 = `!${quote(process.execPath)} ${quote(fileURLToPath(new URL("./git-credential.js", import.meta.url)))}`
  env.GIT_CONFIG_KEY_2 = "credential.useHttpPath"
  env.GIT_CONFIG_VALUE_2 = "true"
}

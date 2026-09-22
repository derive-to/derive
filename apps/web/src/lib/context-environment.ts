// Client mirror of the core environment-name policy: clients cannot import core at runtime.
// The API context-connections tests check parity with its policy.
export const CONTEXT_ENVIRONMENT_LIMIT = 20

const RESERVED_PREFIX =
  /^(?:DERIVE_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|GIT_|LD_|DYLD_|NODE_|NPM_|PYTHON|BASH_|ZSH_|SSH_)/
const RESERVED_NAMES = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "PWD",
  "OLDPWD",
  "ENV",
  "IFS",
  "TMPDIR",
  "TMP",
  "TEMP",
])

export function contextEnvironmentNameError(name: string): string | null {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name))
    return "Use up to 64 uppercase letters, numbers or underscores, starting with a letter"
  if (RESERVED_PREFIX.test(name) || RESERVED_NAMES.has(name))
    return "This name is reserved for the runner"
  return null
}

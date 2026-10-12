export interface RuntimeConfig {
  provider?: "ortam" | "boat"
  apiUrl: string
  /** Absolute path to a pinned CLI installation in the saved sandbox. */
  runnerPath: string
  /** The CLI version the sandbox installs; defaults to RUNNER_VERSION (lib/runtime-setup). */
  runnerVersion?: string
  runnerArchive?: { url: string; sha256: string }
  managed?: { apiKey: string; workspaceIds: ReadonlySet<string> }
}

// The runner a Derive machine (Ortam sandbox) installs once and then launches for every job.
// job-machine.ts runs INSTALL_RUNTIME_RUNNER when it sets a sandbox up.

export const RUNNER_VERSION = "0.8.7"

/** The pinned install must support job tokens and match a versioned runner path. */
export const runnerRunsJobs = (runnerPath: string, installs: string = RUNNER_VERSION): boolean => {
  const [major = 0, minor = 0] = installs.split(".").map(Number)
  const patch = Number(installs.split(".")[2] ?? 0)
  if (major === 0 && (minor < 8 || (minor === 8 && patch < 6))) return false
  const v = /derive-runtime\/(\d+\.\d+\.\d+)\//.exec(runnerPath)
  return !v || v[1] === installs
}
const RUNNER_DIRECTORY = `/home/ortam/derive-runtime/${RUNNER_VERSION}`

/** Install once per saved environment, then atomically expose a complete runner. */
export const INSTALL_RUNTIME_RUNNER = [
  "set -eu",
  "mkdir -p /home/ortam/derive-runtime /home/ortam/work",
  `if [ ! -f ${RUNNER_DIRECTORY}/.ready ]; then`,
  `  test ! -e ${RUNNER_DIRECTORY}`, // Never overwrite an unknown or incomplete installation.
  `  stage=$(mktemp -d /home/ortam/derive-runtime/.install-${RUNNER_VERSION}-XXXXXX)`,
  `  trap 'rm -rf "$stage"' EXIT`,
  `  npm install --prefix "$stage" --omit=dev --ignore-scripts --no-audit --no-fund --save-exact @derive-to/cli@${RUNNER_VERSION}`,
  `  node "$stage/node_modules/@derive-to/cli/bin/derive.js" --help >/dev/null`,
  `  touch "$stage/.ready"`,
  `  mv "$stage" ${RUNNER_DIRECTORY}`,
  "  trap - EXIT",
  "fi",
].join("\n")

/** Self-hosts can install an immutable archive before its public CLI release. */
export const runtimeSetup = (archive?: { url: string; sha256: string }) => {
  const harness =
    'test "$(codex --version 2>/dev/null)" = "codex-cli 0.162.1" || npm install -g --no-audit --no-fund @openai/codex@0.162.1'
  if (!archive) return [INSTALL_RUNTIME_RUNNER, harness].join("\n")
  const url = new URL(archive.url)
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !/^[a-f0-9]{64}$/.test(archive.sha256)
  )
    throw new Error("Runner archives need HTTPS and a SHA-256 checksum")
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  return [
    `mkdir -p ${RUNNER_DIRECTORY}`,
    INSTALL_RUNTIME_RUNNER.replaceAll(RUNNER_DIRECTORY, `${RUNNER_DIRECTORY}/${archive.sha256}`)
      .replace(`@derive-to/cli@${RUNNER_VERSION}`, '"$stage/runner.tgz"')
      .replace(
        "  npm install",
        `  curl --fail --silent --show-error --location ${quote(archive.url)} --output "$stage/runner.tgz"\n  printf '%s  %s\\n' ${quote(archive.sha256)} "$stage/runner.tgz" | sha256sum --check --status\n  npm install`,
      ),
    harness,
  ].join("\n")
}

export const archiveRunnerPath = (sha: string) =>
  `${RUNNER_DIRECTORY}/${sha}/node_modules/@derive-to/cli/bin/derive.js`

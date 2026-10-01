// The runner a Derive machine (Ortam sandbox) installs once and then launches for every job.
// job-machine.ts runs INSTALL_RUNTIME_RUNNER when it sets a sandbox up.

export const RUNNER_VERSION = "0.8.0"
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

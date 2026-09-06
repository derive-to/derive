import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const DERIVE_HOOK_MARKER = "skill scan --quiet"

const readJson = (path) => {
  if (!existsSync(path)) return {}
  const parsed = JSON.parse(readFileSync(path, "utf8"))
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${path} must contain a JSON object`)
  return parsed
}

const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

const hasDeriveHook = (groups) =>
  groups.some((group) =>
    (group?.hooks ?? []).some(
      (hook) => typeof hook?.command === "string" && hook.command.includes(DERIVE_HOOK_MARKER),
    ),
  )

const addSessionEndHook = (path, command) => {
  const config = readJson(path)
  config.hooks ??= {}
  config.hooks.SessionEnd ??= []
  if (hasDeriveHook(config.hooks.SessionEnd)) return false
  config.hooks.SessionEnd.push({
    hooks: [{ type: "command", command, async: true, timeout: 3 }],
  })
  writeJson(path, config)
  return true
}

const xml = (value) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

const installMacSchedule = ({ home, node, cli, client, activate }) => {
  const path = join(home, "Library", "LaunchAgents", "to.derive.skill-scan.plist")
  mkdirSync(dirname(path), { recursive: true })
  const source = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>to.derive.skill-scan</string>
  <key>ProgramArguments</key><array>
    <string>${xml(node)}</string><string>${xml(cli)}</string><string>skill</string><string>scan</string><string>--quiet</string>${client ? `<string>--client</string><string>${xml(client)}</string>` : ""}
  </array>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
</dict></plist>
`
  writeFileSync(path, source)
  if (activate) {
    const domain = `gui/${process.getuid()}`
    spawnSync("launchctl", ["bootout", domain, path], { stdio: "ignore" })
    const result = spawnSync("launchctl", ["bootstrap", domain, path], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(result.stderr.trim() || "launchctl bootstrap failed")
  }
  return path
}

const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`

const installLinuxSchedule = ({ home, node, cli, client, activate }) => {
  const root = join(home, ".config", "systemd", "user")
  const service = join(root, "derive-skill-scan.service")
  const timer = join(root, "derive-skill-scan.timer")
  mkdirSync(root, { recursive: true })
  writeFileSync(
    service,
    `[Unit]\nDescription=Scan local agent logs for Derive Skill use\n\n[Service]\nType=oneshot\nExecStart=${shellQuote(node)} ${shellQuote(cli)} skill scan --quiet${client ? ` --client ${shellQuote(client)}` : ""}\n`,
  )
  writeFileSync(
    timer,
    `[Unit]\nDescription=Scan local agent logs for Derive Skill use\n\n[Timer]\nOnBootSec=5m\nOnUnitActiveSec=30m\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`,
  )
  if (activate) {
    const reload = spawnSync("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" })
    if (reload.status !== 0)
      throw new Error(reload.stderr.trim() || "systemctl daemon-reload failed")
    const enabled = spawnSync(
      "systemctl",
      ["--user", "enable", "--now", "derive-skill-scan.timer"],
      { encoding: "utf8" },
    )
    if (enabled.status !== 0) throw new Error(enabled.stderr.trim() || "systemctl enable failed")
  }
  return timer
}

const installWindowsSchedule = ({ node, cli, client, activate }) => {
  const command = `"${node}" "${cli}" skill scan --quiet${client ? ` --client ${client}` : ""}`
  if (activate) {
    const result = spawnSync(
      "schtasks",
      ["/Create", "/SC", "MINUTE", "/MO", "30", "/TN", "Derive Skill Scan", "/TR", command, "/F"],
      { encoding: "utf8" },
    )
    if (result.status !== 0) throw new Error(result.stderr.trim() || "schtasks create failed")
  }
  return "Task Scheduler: Derive Skill Scan"
}

export function setupSkillScan(options = {}) {
  const home = options.home ?? homedir()
  const node = options.node ?? process.execPath
  const cli = options.cli ?? process.argv[1]
  const platform = options.platform ?? process.platform
  const activate = options.activate ?? true
  if (options.schedule && !["darwin", "linux", "win32"].includes(platform))
    throw new Error(`automatic schedule is not supported on ${platform}`)
  const command = `"${node}" "${cli}" skill scan --quiet${
    options.client ? ` --client ${options.client}` : ""
  }`
  const hooks = [
    {
      client: "codex",
      path: join(home, ".codex", "hooks.json"),
    },
    {
      client: "claude",
      path: join(home, ".claude", "settings.json"),
    },
  ]
    .filter((target) => !options.client || target.client === options.client)
    .map((target) => ({ ...target, changed: addSessionEndHook(target.path, command) }))

  let schedule = null
  if (options.schedule) {
    if (platform === "darwin")
      schedule = installMacSchedule({ home, node, cli, client: options.client, activate })
    else if (platform === "linux")
      schedule = installLinuxSchedule({ home, node, cli, client: options.client, activate })
    else if (platform === "win32")
      schedule = installWindowsSchedule({ node, cli, client: options.client, activate })
  }
  return { hooks, schedule }
}

import { createHash, randomUUID } from "node:crypto"
import { existsSync, constants as fsConstants } from "node:fs"
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { PgMetaStore } from "@derive/db/pg"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { hashPassword } from "better-auth/crypto"
import Database from "better-sqlite3"
import { Pool } from "pg"
import { type AuthDb, makeAuth, migrateAuth } from "./auth-config"
import { resolveAuthSecret } from "./config"

const MANIFEST = "derive-backup.json"
const FORMAT = "derive-lite-backup-v2"

interface BackupFile {
  path: string
  sha256: string
  bytes: number
}

interface BackupIdentity {
  source: "backup" | "environment"
  path?: ".auth-secret" | ".org-id"
  env?: "DERIVE_AUTH_SECRET" | "DERIVE_DEFAULT_ORG_ID"
  fingerprint: string
}

export interface BackupManifest {
  format: typeof FORMAT
  createdAt: string
  topology: "sqlite+filesystem"
  identity: {
    authSecret: BackupIdentity
    defaultOrg: BackupIdentity
  }
  files: BackupFile[]
  sqliteIntegrity: "ok"
}

const sha256File = async (path: string): Promise<{ sha256: string; bytes: number }> => {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`not a regular file: ${path}`)
    const bytes = await handle.readFile()
    return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength }
  } finally {
    await handle.close()
  }
}

const fingerprint = (value: string): string =>
  createHash("sha256").update(`derive-backup-identity:${value}`).digest("hex")

const manifestPath = (root: string, path: string): string =>
  relative(root, path).split(sep).join("/")

async function copyBlobTree(source: string, target: string, root: string, files: BackupFile[]) {
  if (!existsSync(source)) return
  const sourceInfo = await lstat(source)
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory())
    throw new Error(`blob root must be a real directory: ${source}`)
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`refusing to follow blob symlink: ${from}`)
    if (entry.isDirectory()) {
      await copyBlobTree(from, to, root, files)
      continue
    }
    if (!entry.isFile() || entry.name.includes(".tmp-")) continue
    await writeFile(to, await readNoFollow(from), { mode: 0o600 })
    const digest = await sha256File(to)
    const key = `${basename(dirname(to))}${basename(to)}`
    if (!/^[0-9a-f]{64}$/.test(key) || digest.sha256 !== key)
      throw new Error(`blob content does not match its content-addressed key: ${from}`)
    files.push({ path: manifestPath(root, to), ...digest })
  }
}

const readNoFollow = async (path: string): Promise<Buffer> => {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`not a regular file: ${path}`)
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

const sqliteIntegrity = (path: string): "ok" => {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const result = db.pragma("integrity_check", { simple: true })
    if (result !== "ok") throw new Error(`SQLite integrity_check failed: ${String(result)}`)
    return "ok"
  } finally {
    db.close()
  }
}

// SQLite's online backup preserves WAL journal mode. Opening that standalone
// snapshot would manufacture unmanifested -wal/-shm sidecars, so normalize the
// completed copy to a single-file journal before hashing and publishing it.
const normalizeSqliteSnapshot = (path: string): void => {
  const db = new Database(path, { fileMustExist: true })
  try {
    db.pragma("journal_mode = DELETE")
  } finally {
    db.close()
  }
}

/** Online Lite backup: snapshot the WAL database first, then copy immutable,
 * content-addressed blobs. Newer unreferenced blobs are harmless; a DB row can
 * never point at a blob that was written after its transaction. */
export async function createLiteBackup(
  dataDir: string,
  destination: string,
): Promise<BackupManifest> {
  const sourceDb = join(resolve(dataDir), "derive.db")
  if (!existsSync(sourceDb)) throw new Error(`Lite database not found: ${sourceDb}`)
  const sourceDbInfo = await lstat(sourceDb)
  if (sourceDbInfo.isSymbolicLink() || !sourceDbInfo.isFile())
    throw new Error(`Lite database must be a regular file, not a link: ${sourceDb}`)
  const target = resolve(destination)
  if (existsSync(target)) throw new Error(`backup destination already exists: ${target}`)
  await mkdir(dirname(target), { recursive: true })
  const partial = `${target}.partial-${process.pid}`
  await mkdir(partial)
  try {
    const snapshot = join(partial, "derive.db")
    const db = new Database(sourceDb, { readonly: true, fileMustExist: true })
    try {
      await db.backup(snapshot)
    } finally {
      db.close()
    }
    normalizeSqliteSnapshot(snapshot)
    const files: BackupFile[] = [{ path: "derive.db", ...(await sha256File(snapshot)) }]
    await copyBlobTree(join(resolve(dataDir), "blobs"), join(partial, "blobs"), partial, files)
    const identities: Partial<BackupManifest["identity"]> = {}
    for (const [field, name, envName] of [
      ["authSecret", ".auth-secret", "DERIVE_AUTH_SECRET"],
      ["defaultOrg", ".org-id", "DERIVE_DEFAULT_ORG_ID"],
    ] as const) {
      const source = join(resolve(dataDir), name)
      if (existsSync(source)) {
        const value = (await readNoFollow(source)).toString("utf8").trim()
        if (!value) throw new Error(`Lite identity file is empty: ${source}`)
        const targetFile = join(partial, name)
        await writeFile(targetFile, value, { mode: 0o600 })
        files.push({ path: name, ...(await sha256File(targetFile)) })
        identities[field] = {
          source: "backup",
          path: name,
          fingerprint: fingerprint(value),
        }
        continue
      }
      const value = process.env[envName]?.trim()
      if (!value)
        throw new Error(
          `${name} is not persisted and ${envName} is unset; refusing an identity-incomplete backup`,
        )
      identities[field] = {
        source: "environment",
        env: envName,
        fingerprint: fingerprint(value),
      }
    }
    const manifest: BackupManifest = {
      format: FORMAT,
      createdAt: new Date().toISOString(),
      topology: "sqlite+filesystem",
      identity: identities as BackupManifest["identity"],
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
      sqliteIntegrity: sqliteIntegrity(snapshot),
    }
    await writeFile(join(partial, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    })
    await rename(partial, target)
    return manifest
  } catch (error) {
    await rm(partial, { recursive: true, force: true })
    throw error
  }
}

const safeBackupFile = (root: string, path: string): string => {
  if (path.startsWith("/") || path.includes("\\") || path.split("/").includes(".."))
    throw new Error(`invalid backup manifest path: ${path}`)
  const absolute = resolve(root, path)
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`))
    throw new Error(`backup manifest path escapes its directory: ${path}`)
  return absolute
}

const exactKeys = (value: object, keys: string[], label: string): void => {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i]))
    throw new Error(`malformed ${label}`)
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const validateIdentity = (value: unknown, field: "authSecret" | "defaultOrg"): BackupIdentity => {
  if (!isObject(value)) throw new Error(`malformed backup identity.${field}`)
  if (value.source === "backup") {
    exactKeys(value, ["source", "path", "fingerprint"], `backup identity.${field}`)
    const expectedPath = field === "authSecret" ? ".auth-secret" : ".org-id"
    if (value.path !== expectedPath || !/^[0-9a-f]{64}$/.test(String(value.fingerprint)))
      throw new Error(`malformed backup identity.${field}`)
  } else if (value.source === "environment") {
    exactKeys(value, ["source", "env", "fingerprint"], `backup identity.${field}`)
    const expectedEnv = field === "authSecret" ? "DERIVE_AUTH_SECRET" : "DERIVE_DEFAULT_ORG_ID"
    if (value.env !== expectedEnv || !/^[0-9a-f]{64}$/.test(String(value.fingerprint)))
      throw new Error(`malformed backup identity.${field}`)
  } else {
    throw new Error(`malformed backup identity.${field}`)
  }
  return value as unknown as BackupIdentity
}

const parseManifest = (value: unknown): BackupManifest => {
  if (!isObject(value)) throw new Error("unsupported or malformed Derive backup manifest")
  exactKeys(
    value,
    ["format", "createdAt", "topology", "identity", "files", "sqliteIntegrity"],
    "Derive backup manifest",
  )
  if (
    value.format !== FORMAT ||
    value.topology !== "sqlite+filesystem" ||
    value.sqliteIntegrity !== "ok" ||
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    !Array.isArray(value.files) ||
    !isObject(value.identity)
  )
    throw new Error("unsupported or malformed Derive backup manifest")
  exactKeys(value.identity, ["authSecret", "defaultOrg"], "backup identity")
  const identity = {
    authSecret: validateIdentity(value.identity.authSecret, "authSecret"),
    defaultOrg: validateIdentity(value.identity.defaultOrg, "defaultOrg"),
  }
  const files: BackupFile[] = []
  const paths = new Set<string>()
  for (const raw of value.files) {
    if (!isObject(raw)) throw new Error("malformed backup file entry")
    exactKeys(raw, ["path", "sha256", "bytes"], "backup file entry")
    if (
      typeof raw.path !== "string" ||
      !/^[0-9a-f]{64}$/.test(String(raw.sha256)) ||
      !Number.isSafeInteger(raw.bytes) ||
      Number(raw.bytes) < 0 ||
      paths.has(raw.path)
    )
      throw new Error("malformed or duplicate backup file entry")
    paths.add(raw.path)
    files.push({ path: raw.path, sha256: String(raw.sha256), bytes: Number(raw.bytes) })
  }
  if (!paths.has("derive.db")) throw new Error("backup manifest is missing derive.db")
  for (const [field, identityValue] of Object.entries(identity)) {
    const path = field === "authSecret" ? ".auth-secret" : ".org-id"
    const included = paths.has(path)
    if ((identityValue.source === "backup") !== included)
      throw new Error(
        identityValue.source === "backup"
          ? `backup manifest is missing ${path}`
          : `backup manifest must not include environment-supplied identity ${path}`,
      )
  }
  return {
    format: FORMAT,
    createdAt: value.createdAt,
    topology: "sqlite+filesystem",
    identity,
    files,
    sqliteIntegrity: "ok",
  }
}

const allowedBackupPath = (path: string): boolean =>
  path === "derive.db" ||
  path === ".auth-secret" ||
  path === ".org-id" ||
  /^blobs\/[0-9a-f]{2}\/[0-9a-f]{62}$/.test(path)

const backupInventory = async (root: string, directory = root): Promise<string[]> => {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    const info = await lstat(absolute)
    const path = manifestPath(root, absolute)
    if (info.isSymbolicLink()) throw new Error(`backup contains a symbolic link: ${path}`)
    if (info.isDirectory()) {
      if (path !== "blobs" && !/^blobs\/[0-9a-f]{2}$/.test(path))
        throw new Error(`backup contains an unexpected directory: ${path}`)
      files.push(...(await backupInventory(root, absolute)))
      continue
    }
    if (!info.isFile()) throw new Error(`backup contains a non-regular entry: ${path}`)
    files.push(path)
  }
  return files.sort()
}

export async function verifyLiteBackup(directory: string): Promise<BackupManifest> {
  const root = resolve(directory)
  const rootInfo = await lstat(root)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
    throw new Error(`backup root must be a real directory: ${root}`)
  const parsed = parseManifest(
    JSON.parse((await readNoFollow(join(root, MANIFEST))).toString("utf8")),
  )
  const inventory = await backupInventory(root)
  const expected = [...parsed.files.map((file) => file.path), MANIFEST].sort()
  if (inventory.length !== expected.length || inventory.some((path, i) => path !== expected[i]))
    throw new Error("backup inventory does not exactly match its manifest")
  for (const file of parsed.files) {
    if (!allowedBackupPath(file.path)) throw new Error(`unexpected backup path: ${file.path}`)
    const absolute = safeBackupFile(root, file.path)
    const actual = await sha256File(absolute)
    if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes)
      throw new Error(`backup checksum mismatch: ${file.path}`)
    if (file.path.startsWith("blobs/")) {
      const parts = file.path.split("/")
      const key = `${parts.at(-2) ?? ""}${parts.at(-1) ?? ""}`
      if (key !== actual.sha256) throw new Error(`backup blob key mismatch: ${file.path}`)
    }
  }
  for (const identity of Object.values(parsed.identity)) {
    if (identity.source !== "backup") continue
    const value = (await readNoFollow(safeBackupFile(root, identity.path ?? "")))
      .toString("utf8")
      .trim()
    if (fingerprint(value) !== identity.fingerprint)
      throw new Error(`backup identity fingerprint mismatch: ${identity.path}`)
  }
  sqliteIntegrity(join(root, "derive.db"))
  return parsed
}

export async function restoreLiteBackup(directory: string, dataDir: string): Promise<void> {
  const root = resolve(directory)
  const manifest = await verifyLiteBackup(root)
  for (const identity of Object.values(manifest.identity)) {
    if (identity.source !== "environment") continue
    const value = process.env[identity.env ?? ""]?.trim()
    if (!value || fingerprint(value) !== identity.fingerprint)
      throw new Error(`restore requires the same ${identity.env} value recorded by this backup`)
  }
  const target = resolve(dataDir)
  await mkdir(target, { recursive: true })
  const targetInfo = await lstat(target)
  if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory())
    throw new Error(`restore target must be a real directory: ${target}`)
  const entries = await readdir(target)
  if (entries.length > 0)
    throw new Error(
      `restore target must be empty (stop Derive and use a fresh DATA_DIR): ${target}`,
    )
  for (const file of manifest.files) {
    const source = safeBackupFile(root, file.path)
    const destination = safeBackupFile(target, file.path)
    await mkdir(dirname(destination), { recursive: true })
    const bytes = await readNoFollow(source)
    const actual = createHash("sha256").update(bytes).digest("hex")
    if (actual !== file.sha256 || bytes.byteLength !== file.bytes)
      throw new Error(`backup changed during restore: ${file.path}`)
    await writeFile(destination, bytes, { mode: 0o600 })
  }
  sqliteIntegrity(join(target, "derive.db"))
}

async function passwordFromStdin(): Promise<string> {
  if (process.stdin.isTTY)
    throw new Error("refusing a password argument; pipe the new password with --password-stdin")
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/[\r\n]+$/, "")
}

/** Create the first human operator without exposing registration or trusting an
 * email allow-list. Existing accounts and additional operators require explicit
 * recovery flags at the CLI call site. */
export async function bootstrapOperator(
  databaseUrl: string | undefined,
  dataDir: string,
  baseUrl: string,
  input: {
    email: string
    name: string
    password?: string
    adoptExisting?: boolean
    allowAdditional?: boolean
  },
): Promise<{ userId: string; created: boolean }> {
  await mkdir(resolve(dataDir), { recursive: true })
  let meta: SqliteMetaStore | PgMetaStore
  let authDb: AuthDb
  let close: () => Promise<void>
  if (databaseUrl) {
    const pgMeta = await PgMetaStore.create(databaseUrl)
    const pool = new Pool({ connectionString: databaseUrl, max: 1 })
    meta = pgMeta
    authDb = pool
    close = async () => {
      await pgMeta.close()
      await pool.end()
    }
  } else {
    const path = join(resolve(dataDir), "derive.db")
    const sqliteMeta = new SqliteMetaStore(path)
    const db = new Database(path)
    db.pragma("journal_mode = WAL")
    db.pragma("busy_timeout = 5000")
    meta = sqliteMeta
    authDb = db
    close = async () => {
      sqliteMeta.close()
      db.close()
    }
  }

  try {
    if ((await meta.hasInstanceOperators()) && !input.allowAdditional)
      throw new Error(
        "an instance operator already exists; pass --allow-additional only for an intentional recovery/addition",
      )
    const auth = makeAuth(authDb, baseUrl, resolveAuthSecret(dataDir), {
      usernameTaken: (username) => meta.getUserByUsername(username).then(Boolean),
    })
    await migrateAuth(auth)
    const existing = await meta.findUserByEmail(input.email.trim().toLowerCase())
    if (existing && !input.adoptExisting)
      throw new Error(
        "that account already exists; pass --adopt-existing only after verifying its identity",
      )
    let userId = existing?.id
    if (!userId) {
      if (!input.password) throw new Error("a password is required when creating the operator")
      if (input.password.length < 8 || input.password.length > 128)
        throw new Error("password must be between 8 and 128 characters")
      const created = await auth.api.signUpEmail({
        body: {
          email: input.email.trim().toLowerCase(),
          password: input.password,
          name: input.name.trim() || input.email.trim().toLowerCase(),
        },
      })
      userId = created.user.id
    }
    await meta.addInstanceOperator(userId)
    return { userId, created: !existing }
  } finally {
    await close()
  }
}

export async function resetPassword(
  databaseUrl: string | undefined,
  dataDir: string,
  email: string,
  password: string,
): Promise<void> {
  if (password.length < 8 || password.length > 128)
    throw new Error("password must be between 8 and 128 characters")
  const hashed = await hashPassword(password)
  if (databaseUrl) {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 })
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const found = await client.query<{ id: string }>(
        'SELECT id FROM "user" WHERE lower(email) = lower($1) LIMIT 1',
        [email],
      )
      const userId = found.rows[0]?.id
      if (!userId) throw new Error(`no user found for ${email}`)
      const updated = await client.query(
        'UPDATE account SET password = $1, "updatedAt" = $2 WHERE "userId" = $3 AND "providerId" = \'credential\'',
        [hashed, new Date(), userId],
      )
      if (updated.rowCount === 0)
        await client.query(
          'INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES ($1,$2,\'credential\',$2,$3,$4,$4)',
          [randomUUID(), userId, hashed, new Date()],
        )
      await client.query('DELETE FROM session WHERE "userId" = $1', [userId])
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
      await pool.end()
    }
    return
  }
  const db = new Database(join(resolve(dataDir), "derive.db"), {
    fileMustExist: true,
  })
  try {
    db.transaction(() => {
      const user = db
        .prepare('SELECT id FROM "user" WHERE lower(email) = lower(?) LIMIT 1')
        .get(email) as { id: string } | undefined
      if (!user) throw new Error(`no user found for ${email}`)
      const now = new Date().toISOString()
      const result = db
        .prepare(
          'UPDATE account SET password = ?, "updatedAt" = ? WHERE "userId" = ? AND "providerId" = \'credential\'',
        )
        .run(hashed, now, user.id)
      if (result.changes === 0)
        db.prepare(
          'INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES (?, ?, \'credential\', ?, ?, ?, ?)',
        ).run(randomUUID(), user.id, user.id, hashed, now, now)
      db.prepare('DELETE FROM session WHERE "userId" = ?').run(user.id)
    })()
  } finally {
    db.close()
  }
}

const argValue = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

export async function runAdminCommand(command: string, args: string[]): Promise<string> {
  const dataDir = process.env.DATA_DIR ?? "./data"
  if (command === "backup") {
    if (process.env.DATABASE_URL || process.env.OBJECT_STORE_URL)
      throw new Error("backup is for the Lite (SQLite + local blobs) topology only")
    const destination = args[0]
    if (!destination) throw new Error("usage: derive-server backup <destination-directory>")
    const manifest = await createLiteBackup(dataDir, destination)
    return `backup created and verified: ${resolve(destination)} (${manifest.files.length} files)`
  }
  if (command === "verify-backup") {
    const directory = args[0]
    if (!directory) throw new Error("usage: derive-server verify-backup <directory>")
    const manifest = await verifyLiteBackup(directory)
    return `backup verified: ${resolve(directory)} (${manifest.files.length} files)`
  }
  if (command === "bootstrap-operator") {
    const email = argValue(args, "--email")
    const adoptExisting = args.includes("--adopt-existing")
    const needsPassword = !adoptExisting
    if (!email || (needsPassword && !args.includes("--password-stdin")))
      throw new Error(
        "usage: derive-server bootstrap-operator --email owner@example.com --password-stdin [--name 'Owner'] [--adopt-existing] [--allow-additional]",
      )
    const result = await bootstrapOperator(
      process.env.DATABASE_URL,
      dataDir,
      process.env.BASE_URL ?? "http://localhost:8080",
      {
        email,
        name: argValue(args, "--name") ?? email,
        password: needsPassword ? await passwordFromStdin() : undefined,
        adoptExisting,
        allowAdditional: args.includes("--allow-additional"),
      },
    )
    return `${result.created ? "created" : "adopted"} instance operator ${email} (${result.userId})`
  }
  if (command === "restore-backup") {
    const directory = args[0]
    if (!directory) throw new Error("usage: derive-server restore-backup <directory>")
    if (process.env.DATABASE_URL || process.env.OBJECT_STORE_URL)
      throw new Error("restore-backup is for the Lite (SQLite + local blobs) topology only")
    await restoreLiteBackup(directory, dataDir)
    return `backup restored into ${resolve(dataDir)}`
  }
  if (command === "reset-password") {
    const email = argValue(args, "--email")
    if (!email || !args.includes("--password-stdin"))
      throw new Error(
        "usage: derive-server reset-password --email user@example.com --password-stdin",
      )
    await resetPassword(process.env.DATABASE_URL, dataDir, email, await passwordFromStdin())
    return `password reset and sessions revoked for ${email}`
  }
  throw new Error(
    `unknown command: ${command}\ncommands: serve, bootstrap-operator, backup, verify-backup, restore-backup, reset-password`,
  )
}

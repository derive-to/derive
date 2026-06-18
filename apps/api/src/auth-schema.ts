import { customType, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Drizzle schema for Better Auth's tables — the single source of truth for the
 * edge (D1) auth adapter. Transcribed verbatim from the live D1 DDL (the tables
 * Better Auth's own migrator created), so the drizzle adapter reads/writes the
 * exact same columns the data already lives in. Field keys are Better Auth's model
 * field names (camelCase) and match the column names 1:1.
 */

/**
 * Better Auth's drizzle adapter hands `date` fields to the driver as JS `Date`
 * objects (it pairs them with a `new Date(value)` read transform). D1's `bind()`
 * rejects `Date` objects outright, and the existing rows store dates as ISO strings
 * (the kysely migrator's text `date` columns). This column bridges both: it stores
 * text, serialises `Date` → ISO string on write (so D1 accepts it and the on-disk
 * format is unchanged), and returns the stored string on read (Better Auth wraps it
 * back into a `Date`). Existing string values pass through untouched.
 */
const isoDate = customType<{ data: string | Date; driverData: string }>({
  dataType() {
    return "text"
  },
  toDriver(value) {
    return value instanceof Date ? value.toISOString() : value
  },
})

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull(),
  image: text("image"),
  createdAt: isoDate("createdAt").notNull(),
  updatedAt: isoDate("updatedAt").notNull(),
  username: text("username"),
  discoverable: integer("discoverable", { mode: "boolean" }),
  profession: text("profession"),
  about: text("about"),
})

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: isoDate("expiresAt").notNull(),
  token: text("token").notNull().unique(),
  createdAt: isoDate("createdAt").notNull(),
  updatedAt: isoDate("updatedAt").notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId").notNull(),
})

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId").notNull(),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: isoDate("accessTokenExpiresAt"),
  refreshTokenExpiresAt: isoDate("refreshTokenExpiresAt"),
  scope: text("scope"),
  password: text("password"),
  createdAt: isoDate("createdAt").notNull(),
  updatedAt: isoDate("updatedAt").notNull(),
})

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: isoDate("expiresAt").notNull(),
  createdAt: isoDate("createdAt").notNull(),
  updatedAt: isoDate("updatedAt").notNull(),
})

export const jwks = sqliteTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("publicKey").notNull(),
  privateKey: text("privateKey").notNull(),
  createdAt: isoDate("createdAt").notNull(),
  expiresAt: isoDate("expiresAt"),
})

export const oauthClient = sqliteTable("oauthClient", {
  id: text("id").primaryKey(),
  clientId: text("clientId").notNull().unique(),
  clientSecret: text("clientSecret"),
  disabled: integer("disabled", { mode: "boolean" }),
  skipConsent: integer("skipConsent", { mode: "boolean" }),
  enableEndSession: integer("enableEndSession", { mode: "boolean" }),
  subjectType: text("subjectType"),
  scopes: text("scopes"),
  userId: text("userId"),
  createdAt: isoDate("createdAt"),
  updatedAt: isoDate("updatedAt"),
  name: text("name"),
  uri: text("uri"),
  icon: text("icon"),
  contacts: text("contacts"),
  tos: text("tos"),
  policy: text("policy"),
  softwareId: text("softwareId"),
  softwareVersion: text("softwareVersion"),
  softwareStatement: text("softwareStatement"),
  redirectUris: text("redirectUris").notNull(),
  postLogoutRedirectUris: text("postLogoutRedirectUris"),
  tokenEndpointAuthMethod: text("tokenEndpointAuthMethod"),
  grantTypes: text("grantTypes"),
  responseTypes: text("responseTypes"),
  public: integer("public", { mode: "boolean" }),
  type: text("type"),
  requirePKCE: integer("requirePKCE", { mode: "boolean" }),
  referenceId: text("referenceId"),
  metadata: text("metadata"),
})

export const oauthAccessToken = sqliteTable("oauthAccessToken", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  clientId: text("clientId").notNull(),
  sessionId: text("sessionId"),
  userId: text("userId"),
  referenceId: text("referenceId"),
  refreshId: text("refreshId"),
  expiresAt: isoDate("expiresAt").notNull(),
  createdAt: isoDate("createdAt").notNull(),
  scopes: text("scopes").notNull(),
})

export const oauthRefreshToken = sqliteTable("oauthRefreshToken", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  clientId: text("clientId").notNull(),
  sessionId: text("sessionId"),
  userId: text("userId").notNull(),
  referenceId: text("referenceId"),
  expiresAt: isoDate("expiresAt").notNull(),
  createdAt: isoDate("createdAt").notNull(),
  revoked: isoDate("revoked"),
  authTime: isoDate("authTime"),
  scopes: text("scopes").notNull(),
})

export const oauthConsent = sqliteTable("oauthConsent", {
  id: text("id").primaryKey(),
  clientId: text("clientId").notNull(),
  userId: text("userId"),
  referenceId: text("referenceId"),
  scopes: text("scopes").notNull(),
  createdAt: isoDate("createdAt").notNull(),
  updatedAt: isoDate("updatedAt").notNull(),
})

/** The full schema object handed to `drizzle()` and `drizzleAdapter` — keys are the
 *  Better Auth model names (which equal the table names here). */
export const authSchema = {
  user,
  session,
  account,
  verification,
  jwks,
  oauthClient,
  oauthAccessToken,
  oauthRefreshToken,
  oauthConsent,
}

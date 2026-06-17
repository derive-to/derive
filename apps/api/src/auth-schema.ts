import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Drizzle schema for Better Auth's tables — the single source of truth for the
 * edge (D1) auth adapter. Transcribed verbatim from the live D1 DDL (the tables
 * Better Auth's own migrator created), so the drizzle adapter reads/writes the
 * exact same columns the data already lives in.
 *
 * Field keys are Better Auth's model field names (camelCase) and must match the
 * column names 1:1. Date fields are `text`: the existing rows store ISO strings
 * (the kysely migrator's `date` affinity), and the drizzle adapter wraps reads in
 * `new Date(value)`, which parses those strings — so existing users/sessions keep
 * working. Booleans are `integer` (0/1), which Better Auth maps for us.
 */

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified").notNull(),
  image: text("image"),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
  username: text("username"),
  discoverable: integer("discoverable"),
  profession: text("profession"),
  about: text("about"),
})

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: text("expiresAt").notNull(),
  token: text("token").notNull().unique(),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
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
  accessTokenExpiresAt: text("accessTokenExpiresAt"),
  refreshTokenExpiresAt: text("refreshTokenExpiresAt"),
  scope: text("scope"),
  password: text("password"),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
})

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: text("expiresAt").notNull(),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
})

export const jwks = sqliteTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("publicKey").notNull(),
  privateKey: text("privateKey").notNull(),
  createdAt: text("createdAt").notNull(),
  expiresAt: text("expiresAt"),
})

export const oauthClient = sqliteTable("oauthClient", {
  id: text("id").primaryKey(),
  clientId: text("clientId").notNull().unique(),
  clientSecret: text("clientSecret"),
  disabled: integer("disabled"),
  skipConsent: integer("skipConsent"),
  enableEndSession: integer("enableEndSession"),
  subjectType: text("subjectType"),
  scopes: text("scopes"),
  userId: text("userId"),
  createdAt: text("createdAt"),
  updatedAt: text("updatedAt"),
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
  public: integer("public"),
  type: text("type"),
  requirePKCE: integer("requirePKCE"),
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
  expiresAt: text("expiresAt").notNull(),
  createdAt: text("createdAt").notNull(),
  scopes: text("scopes").notNull(),
})

export const oauthRefreshToken = sqliteTable("oauthRefreshToken", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  clientId: text("clientId").notNull(),
  sessionId: text("sessionId"),
  userId: text("userId").notNull(),
  referenceId: text("referenceId"),
  expiresAt: text("expiresAt").notNull(),
  createdAt: text("createdAt").notNull(),
  revoked: text("revoked"),
  authTime: text("authTime"),
  scopes: text("scopes").notNull(),
})

export const oauthConsent = sqliteTable("oauthConsent", {
  id: text("id").primaryKey(),
  clientId: text("clientId").notNull(),
  userId: text("userId"),
  referenceId: text("referenceId"),
  scopes: text("scopes").notNull(),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
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

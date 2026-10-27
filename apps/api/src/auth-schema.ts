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
  twoFactorEnabled: integer("twoFactorEnabled", { mode: "boolean" }),
  username: text("username"),
  discoverable: integer("discoverable", { mode: "boolean" }),
  profession: text("profession"),
  about: text("about"),
  onboarded: integer("onboarded", { mode: "boolean" }),
  brandprint: text("brandprint"),
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

export const passkey = sqliteTable("passkey", {
  id: text("id").primaryKey(),
  name: text("name"),
  publicKey: text("publicKey").notNull(),
  userId: text("userId").notNull(),
  credentialID: text("credentialID").notNull(),
  counter: integer("counter").notNull(),
  deviceType: text("deviceType").notNull(),
  backedUp: integer("backedUp", { mode: "boolean" }).notNull(),
  transports: text("transports"),
  createdAt: isoDate("createdAt"),
  aaguid: text("aaguid"),
})

export const twoFactor = sqliteTable("twoFactor", {
  id: text("id").primaryKey(),
  secret: text("secret").notNull(),
  backupCodes: text("backupCodes").notNull(),
  userId: text("userId").notNull(),
  verified: integer("verified", { mode: "boolean" }),
  failedVerificationCount: integer("failedVerificationCount"),
  lockedUntil: isoDate("lockedUntil"),
})

export const jwks = sqliteTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("publicKey").notNull(),
  privateKey: text("privateKey").notNull(),
  createdAt: isoDate("createdAt").notNull(),
  expiresAt: isoDate("expiresAt"),
  alg: text("alg"),
  crv: text("crv"),
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
  requirePKCE: integer("requirePKCE", { mode: "boolean" }),
  referenceId: text("referenceId"),
  metadata: text("metadata"),
  // Added by Better Auth 1.7. It dropped 1.6's nullable `public` and `type`, which an
  // upgraded D1 still carries; leaving them out of this schema means they are never written.
  clientDiscoveryId: text("clientDiscoveryId"),
  clientCredentialsScopes: text("clientCredentialsScopes"),
  backchannelLogoutUri: text("backchannelLogoutUri"),
  backchannelLogoutSessionRequired: integer("backchannelLogoutSessionRequired", {
    mode: "boolean",
  }),
  applicationType: text("applicationType"),
  jwks: text("jwks"),
  jwksUri: text("jwksUri"),
  dpopBoundAccessTokens: integer("dpopBoundAccessTokens", { mode: "boolean" }),
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
  authorizationCodeId: text("authorizationCodeId"),
  resources: text("resources"),
  requestedUserInfoClaims: text("requestedUserInfoClaims"),
  revoked: isoDate("revoked"),
  confirmation: text("confirmation"),
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
  authorizationCodeId: text("authorizationCodeId"),
  resources: text("resources"),
  requestedUserInfoClaims: text("requestedUserInfoClaims"),
  rotatedAt: isoDate("rotatedAt"),
  rotationReplayResponse: text("rotationReplayResponse"),
  rotationReplayExpiresAt: isoDate("rotationReplayExpiresAt"),
  confirmation: text("confirmation"),
})

export const oauthConsent = sqliteTable("oauthConsent", {
  id: text("id").primaryKey(),
  clientId: text("clientId").notNull(),
  userId: text("userId"),
  referenceId: text("referenceId"),
  scopes: text("scopes").notNull(),
  createdAt: isoDate("createdAt").notNull(),
  updatedAt: isoDate("updatedAt").notNull(),
  resources: text("resources"),
  requestedUserInfoClaims: text("requestedUserInfoClaims"),
})

// Better Auth 1.7 protected resources: one row per RFC 8707 identifier (seeded from the
// `resources` option), optional per-client links, and single-use client assertions.
export const oauthResource = sqliteTable("oauthResource", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("accessTokenTtl"),
  refreshTokenTtl: integer("refreshTokenTtl"),
  signingAlgorithm: text("signingAlgorithm"),
  signingKeyId: text("signingKeyId"),
  allowedScopes: text("allowedScopes"),
  customClaims: text("customClaims"),
  dpopBoundAccessTokensRequired: integer("dpopBoundAccessTokensRequired", { mode: "boolean" }),
  disabled: integer("disabled", { mode: "boolean" }),
  createdAt: isoDate("createdAt"),
  updatedAt: isoDate("updatedAt"),
  policyVersion: integer("policyVersion"),
  metadata: text("metadata"),
})

export const oauthClientResource = sqliteTable("oauthClientResource", {
  id: text("id").primaryKey(),
  clientId: text("clientId").notNull(),
  resourceId: text("resourceId").notNull(),
  metadata: text("metadata"),
  createdAt: isoDate("createdAt"),
})

export const oauthClientAssertion = sqliteTable("oauthClientAssertion", {
  id: text("id").primaryKey(),
  expiresAt: isoDate("expiresAt").notNull(),
})

/** The full schema object handed to `drizzle()` and `drizzleAdapter` — keys are the
 *  Better Auth model names (which equal the table names here). */
export const authSchema = {
  user,
  session,
  account,
  verification,
  passkey,
  twoFactor,
  jwks,
  oauthClient,
  oauthAccessToken,
  oauthRefreshToken,
  oauthConsent,
  oauthResource,
  oauthClientResource,
  oauthClientAssertion,
}

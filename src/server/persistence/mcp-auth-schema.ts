import {
  customType,
  index,
  uniqueIndex,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { users, sessions } from "./schema";
const authDate = customType<{ data: string | number; driverData: string | number }>({
  dataType: () => "date",
});
export const jwks = sqliteTable("jwks", {
  id: text().primaryKey(),
  publicKey: text().notNull(),
  privateKey: text().notNull(),
  createdAt: authDate().notNull(),
  expiresAt: authDate(),
  alg: text(),
  crv: text(),
});
export const oauthClient = sqliteTable(
  "oauthClient",
  {
    id: text().primaryKey(),
    clientId: text().notNull().unique(),
    clientSecret: text(),
    disabled: integer().default(0),
    skipConsent: integer(),
    enableEndSession: integer(),
    subjectType: text(),
    scopes: text(),
    userId: text().references(() => users.id, { onDelete: "cascade" }),
    createdAt: authDate(),
    updatedAt: authDate(),
    name: text(),
    uri: text(),
    icon: text(),
    contacts: text(),
    tos: text(),
    policy: text(),
    softwareId: text(),
    softwareVersion: text(),
    softwareStatement: text(),
    redirectUris: text().notNull(),
    postLogoutRedirectUris: text(),
    tokenEndpointAuthMethod: text(),
    grantTypes: text(),
    responseTypes: text(),
    public: integer(),
    type: text(),
    requirePKCE: integer(),
    referenceId: text(),
    metadata: text(),
    clientDiscoveryId: text(),
    clientCredentialsScopes: text().default("[]"),
    backchannelLogoutUri: text(),
    backchannelLogoutSessionRequired: integer(),
    applicationType: text(),
    jwks: text(),
    jwksUri: text(),
    dpopBoundAccessTokens: integer().default(0),
  },
  (table) => [index("oauthClient_userId_idx").on(table.userId)],
);
export const oauthResource = sqliteTable("oauthResource", {
  id: text().primaryKey(),
  identifier: text().notNull().unique(),
  name: text().notNull(),
  accessTokenTtl: integer(),
  refreshTokenTtl: integer(),
  signingAlgorithm: text(),
  signingKeyId: text(),
  allowedScopes: text(),
  customClaims: text(),
  dpopBoundAccessTokensRequired: integer().default(0),
  disabled: integer().default(0),
  createdAt: authDate(),
  updatedAt: authDate(),
  policyVersion: integer().default(1),
  metadata: text(),
});
export const oauthClientResource = sqliteTable(
  "oauthClientResource",
  {
    id: text().primaryKey(),
    clientId: text()
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    resourceId: text()
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
    metadata: text(),
    createdAt: authDate(),
  },
  (table) => [
    index("oauthClientResource_clientId_idx").on(table.clientId),
    index("oauthClientResource_resourceId_idx").on(table.resourceId),
    uniqueIndex("oauthClientResource_clientId_resourceId_uidx").on(
      table.clientId,
      table.resourceId,
    ),
  ],
);
export const oauthRefreshToken = sqliteTable(
  "oauthRefreshToken",
  {
    id: text().primaryKey(),
    token: text().notNull().unique(),
    clientId: text()
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text().references(() => sessions.id, { onDelete: "set null" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    referenceId: text(),
    expiresAt: authDate().notNull(),
    createdAt: authDate().notNull(),
    revoked: authDate(),
    authTime: authDate(),
    scopes: text().notNull(),
    authorizationCodeId: text(),
    resources: text(),
    requestedUserInfoClaims: text(),
    rotatedAt: authDate(),
    rotationReplayResponse: text(),
    rotationReplayExpiresAt: authDate(),
    confirmation: text(),
  },
  (table) => [
    index("oauthRefreshToken_clientId_idx").on(table.clientId),
    index("oauthRefreshToken_sessionId_idx").on(table.sessionId),
    index("oauthRefreshToken_userId_idx").on(table.userId),
    index("oauthRefreshToken_authorizationCodeId_idx").on(table.authorizationCodeId),
  ],
);
export const oauthAccessToken = sqliteTable(
  "oauthAccessToken",
  {
    id: text().primaryKey(),
    token: text().notNull().unique(),
    clientId: text()
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text().references(() => sessions.id, { onDelete: "set null" }),
    userId: text().references(() => users.id, { onDelete: "cascade" }),
    referenceId: text(),
    refreshId: text().references(() => oauthRefreshToken.id, { onDelete: "cascade" }),
    expiresAt: authDate().notNull(),
    createdAt: authDate().notNull(),
    scopes: text().notNull(),
    authorizationCodeId: text(),
    resources: text(),
    requestedUserInfoClaims: text(),
    revoked: authDate(),
    confirmation: text(),
  },
  (table) => [
    index("oauthAccessToken_clientId_idx").on(table.clientId),
    index("oauthAccessToken_sessionId_idx").on(table.sessionId),
    index("oauthAccessToken_userId_idx").on(table.userId),
    index("oauthAccessToken_authorizationCodeId_idx").on(table.authorizationCodeId),
    index("oauthAccessToken_refreshId_idx").on(table.refreshId),
  ],
);
export const oauthConsent = sqliteTable(
  "oauthConsent",
  {
    id: text().primaryKey(),
    clientId: text()
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    userId: text().references(() => users.id, { onDelete: "cascade" }),
    referenceId: text(),
    scopes: text().notNull(),
    createdAt: authDate().notNull(),
    updatedAt: authDate().notNull(),
    resources: text(),
    requestedUserInfoClaims: text(),
  },
  (table) => [
    index("oauthConsent_clientId_idx").on(table.clientId),
    index("oauthConsent_userId_idx").on(table.userId),
  ],
);
export const oauthClientAssertion = sqliteTable("oauthClientAssertion", {
  id: text().primaryKey(),
  expiresAt: authDate().notNull(),
});

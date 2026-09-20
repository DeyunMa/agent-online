-- OAuth Provider 1.6.25 and JWT schema. Additive; no business data changes.

CREATE TABLE "jwks" (
 "id" TEXT PRIMARY KEY NOT NULL,
 "publicKey" TEXT NOT NULL,
 "privateKey" TEXT NOT NULL,
 "createdAt" DATE NOT NULL,
 "expiresAt" DATE
);


CREATE TABLE "oauthClient" (
 "id" TEXT PRIMARY KEY NOT NULL,
 "clientId" TEXT NOT NULL UNIQUE,
 "clientSecret" TEXT,
 "disabled" INTEGER DEFAULT 0,
 "skipConsent" INTEGER,
 "enableEndSession" INTEGER,
 "subjectType" TEXT,
 "scopes" TEXT,
 "userId" TEXT REFERENCES "user"("id") ON DELETE CASCADE,
 "createdAt" DATE,
 "updatedAt" DATE,
 "name" TEXT,
 "uri" TEXT,
 "icon" TEXT,
 "contacts" TEXT,
 "tos" TEXT,
 "policy" TEXT,
 "softwareId" TEXT,
 "softwareVersion" TEXT,
 "softwareStatement" TEXT,
 "redirectUris" TEXT NOT NULL,
 "postLogoutRedirectUris" TEXT,
 "tokenEndpointAuthMethod" TEXT,
 "grantTypes" TEXT,
 "responseTypes" TEXT,
 "public" INTEGER,
 "type" TEXT,
 "requirePKCE" INTEGER,
 "referenceId" TEXT,
 "metadata" TEXT
);
CREATE INDEX "oauthClient_userId_idx" ON "oauthClient"("userId");

CREATE TABLE "oauthRefreshToken" (
 "id" TEXT PRIMARY KEY NOT NULL,
 "token" TEXT NOT NULL UNIQUE,
 "clientId" TEXT NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
 "sessionId" TEXT REFERENCES "session"("id") ON DELETE SET NULL,
 "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
 "referenceId" TEXT,
 "expiresAt" DATE NOT NULL,
 "createdAt" DATE NOT NULL,
 "revoked" DATE,
 "authTime" DATE,
 "scopes" TEXT NOT NULL
);
CREATE INDEX "oauthRefreshToken_clientId_idx" ON "oauthRefreshToken"("clientId");
CREATE INDEX "oauthRefreshToken_sessionId_idx" ON "oauthRefreshToken"("sessionId");
CREATE INDEX "oauthRefreshToken_userId_idx" ON "oauthRefreshToken"("userId");

CREATE TABLE "oauthAccessToken" (
 "id" TEXT PRIMARY KEY NOT NULL,
 "token" TEXT NOT NULL UNIQUE,
 "clientId" TEXT NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
 "sessionId" TEXT REFERENCES "session"("id") ON DELETE SET NULL,
 "userId" TEXT REFERENCES "user"("id") ON DELETE CASCADE,
 "referenceId" TEXT,
 "refreshId" TEXT REFERENCES "oauthRefreshToken"("id") ON DELETE CASCADE,
 "expiresAt" DATE NOT NULL,
 "createdAt" DATE NOT NULL,
 "scopes" TEXT NOT NULL
);
CREATE INDEX "oauthAccessToken_clientId_idx" ON "oauthAccessToken"("clientId");
CREATE INDEX "oauthAccessToken_sessionId_idx" ON "oauthAccessToken"("sessionId");
CREATE INDEX "oauthAccessToken_userId_idx" ON "oauthAccessToken"("userId");
CREATE INDEX "oauthAccessToken_refreshId_idx" ON "oauthAccessToken"("refreshId");

CREATE TABLE "oauthConsent" (
 "id" TEXT PRIMARY KEY NOT NULL,
 "clientId" TEXT NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
 "userId" TEXT REFERENCES "user"("id") ON DELETE CASCADE,
 "referenceId" TEXT,
 "scopes" TEXT NOT NULL,
 "createdAt" DATE NOT NULL,
 "updatedAt" DATE NOT NULL
);
CREATE INDEX "oauthConsent_clientId_idx" ON "oauthConsent"("clientId");
CREATE INDEX "oauthConsent_userId_idx" ON "oauthConsent"("userId");

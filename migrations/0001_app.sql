CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL,
  image TEXT,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  expiresAt DATE NOT NULL,
  token TEXT NOT NULL UNIQUE,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS session_userId_idx ON session (userId);

CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt DATE,
  refreshTokenExpiresAt DATE,
  scope TEXT,
  password TEXT,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL
);

CREATE INDEX IF NOT EXISTS account_userId_idx ON account (userId);

CREATE TABLE IF NOT EXISTS verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt DATE NOT NULL,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL
);

CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification (identifier);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  default_agent_runtime_id TEXT NOT NULL DEFAULT 'pi',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS projects_by_user_updated_at
  ON projects (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS sandbox_leases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects (id) ON DELETE CASCADE,
  sandbox_runtime_id TEXT NOT NULL,
  provider_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('stopped', 'starting', 'ready', 'busy', 'idle', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sandbox_leases_by_status
  ON sandbox_leases (status);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  agent_run_id TEXT REFERENCES agent_runs (id) ON DELETE SET NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, sequence)
);

CREATE INDEX IF NOT EXISTS messages_by_project_created_at
  ON messages (project_id, created_at ASC);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  input_message_id TEXT REFERENCES messages (id) ON DELETE SET NULL,
  sandbox_lease_id TEXT NOT NULL REFERENCES sandbox_leases (id) ON DELETE RESTRICT,
  agent_runtime_id TEXT NOT NULL,
  sandbox_runtime_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'starting', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted')),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  total_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  model_request_count INTEGER NOT NULL DEFAULT 0 CHECK (model_request_count >= 0),
  sandbox_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (sandbox_duration_ms >= 0),
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS agent_runs_by_project_created_at
  ON agent_runs (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_runs_by_user_created_at
  ON agent_runs (user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_one_active_per_project
  ON agent_runs (project_id)
  WHERE status IN ('queued', 'starting', 'running', 'cancelling');

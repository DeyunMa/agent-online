CREATE TABLE IF NOT EXISTS preview_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects (id) ON DELETE CASCADE,
  sandbox_lease_id TEXT NOT NULL REFERENCES sandbox_leases (id) ON DELETE CASCADE,
  provider_sandbox_ref TEXT NOT NULL,
  provider_process_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('starting', 'running')),
  port INTEGER NOT NULL CHECK (port = 3000),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS agent_runs_block_starting_preview
BEFORE INSERT ON agent_runs
WHEN EXISTS (
  SELECT 1
  FROM preview_sessions
  WHERE project_id = NEW.project_id
    AND status = 'starting'
)
BEGIN
  SELECT RAISE(ABORT, 'project_preview_starting');
END;

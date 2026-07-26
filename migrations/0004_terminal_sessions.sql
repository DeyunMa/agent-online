CREATE TABLE IF NOT EXISTS terminal_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects (id) ON DELETE CASCADE,
  sandbox_lease_id TEXT NOT NULL REFERENCES sandbox_leases (id) ON DELETE CASCADE,
  provider_sandbox_ref TEXT,
  provider_process_ref TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS agent_runs_block_active_terminal
BEFORE INSERT ON agent_runs
WHEN EXISTS (
  SELECT 1
  FROM terminal_sessions
  WHERE project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'project_terminal_active');
END;

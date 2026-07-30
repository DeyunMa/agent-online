CREATE TABLE IF NOT EXISTS archived_run_usage (
  run_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  project_title TEXT NOT NULL,
  agent_runtime_id TEXT NOT NULL,
  sandbox_runtime_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted')
  ),
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
  model_request_count INTEGER NOT NULL CHECK (model_request_count >= 0),
  sandbox_duration_ms INTEGER NOT NULL CHECK (sandbox_duration_ms >= 0),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  deleted_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS archived_run_usage_by_user_created_at
  ON archived_run_usage (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS archived_run_usage_by_user_project
  ON archived_run_usage (user_id, project_id);

CREATE INDEX IF NOT EXISTS archived_run_usage_by_user_agent_runtime
  ON archived_run_usage (user_id, agent_runtime_id);

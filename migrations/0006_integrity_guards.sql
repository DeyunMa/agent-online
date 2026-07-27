CREATE TRIGGER IF NOT EXISTS agent_runs_validate_insert_ownership
BEFORE INSERT ON agent_runs
WHEN NOT EXISTS (
  SELECT 1
  FROM projects
  INNER JOIN sandbox_leases
    ON sandbox_leases.id = NEW.sandbox_lease_id
   AND sandbox_leases.project_id = projects.id
   AND sandbox_leases.sandbox_runtime_id = NEW.sandbox_runtime_id
  WHERE projects.id = NEW.project_id
    AND projects.user_id = NEW.user_id
)
OR (
  NEW.input_message_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM messages
    WHERE messages.id = NEW.input_message_id
      AND messages.project_id = NEW.project_id
      AND messages.role = 'user'
      AND messages.agent_run_id IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_agent_run_ownership');
END;

CREATE TRIGGER IF NOT EXISTS agent_runs_validate_status_transition
BEFORE UPDATE OF status ON agent_runs
WHEN OLD.status != NEW.status
AND NOT (
  (OLD.status = 'queued' AND NEW.status IN ('starting', 'cancelled', 'failed'))
  OR (
    OLD.status = 'starting'
    AND NEW.status IN ('running', 'cancelling', 'failed', 'timed_out', 'interrupted')
  )
  OR (
    OLD.status = 'running'
    AND NEW.status IN ('succeeded', 'cancelling', 'failed', 'timed_out', 'interrupted')
  )
  OR (
    OLD.status = 'cancelling'
    AND NEW.status IN ('cancelled', 'failed', 'timed_out', 'interrupted')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_agent_run_transition');
END;

CREATE TRIGGER IF NOT EXISTS messages_validate_agent_link
BEFORE INSERT ON messages
WHEN (
  NEW.role = 'user'
  AND NEW.agent_run_id IS NOT NULL
)
OR (
  NEW.role = 'assistant'
  AND (
    NEW.agent_run_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM agent_runs
      WHERE agent_runs.id = NEW.agent_run_id
        AND agent_runs.project_id = NEW.project_id
        AND agent_runs.status = 'succeeded'
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_message_agent_run_link');
END;

CREATE TRIGGER IF NOT EXISTS terminal_sessions_validate_lease
BEFORE INSERT ON terminal_sessions
WHEN NOT EXISTS (
  SELECT 1
  FROM sandbox_leases
  WHERE sandbox_leases.id = NEW.sandbox_lease_id
    AND sandbox_leases.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_terminal_lease');
END;

CREATE TRIGGER IF NOT EXISTS preview_sessions_validate_lease
BEFORE INSERT ON preview_sessions
WHEN NOT EXISTS (
  SELECT 1
  FROM sandbox_leases
  WHERE sandbox_leases.id = NEW.sandbox_lease_id
    AND sandbox_leases.project_id = NEW.project_id
    AND sandbox_leases.provider_ref = NEW.provider_sandbox_ref
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_preview_lease');
END;

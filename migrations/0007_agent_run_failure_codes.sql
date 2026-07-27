ALTER TABLE agent_runs
ADD COLUMN failure_code TEXT CHECK (
  failure_code IS NULL
  OR failure_code IN (
    'run.start_failed',
    'run.sandbox_failed',
    'run.agent_protocol_failed',
    'run.agent_process_failed',
    'run.model_failed',
    'run.no_visible_reply',
    'run.timed_out',
    'run.interrupted',
    'run.internal_failed'
  )
);

UPDATE agent_runs
SET failure_code = CASE status
  WHEN 'failed' THEN 'run.internal_failed'
  WHEN 'timed_out' THEN 'run.timed_out'
  WHEN 'interrupted' THEN 'run.interrupted'
  ELSE NULL
END;

CREATE TRIGGER IF NOT EXISTS agent_runs_validate_failure_code_insert
BEFORE INSERT ON agent_runs
WHEN COALESCE((
  (
    NEW.status = 'failed'
    AND NEW.failure_code IN (
      'run.start_failed',
      'run.sandbox_failed',
      'run.agent_protocol_failed',
      'run.agent_process_failed',
      'run.model_failed',
      'run.no_visible_reply',
      'run.internal_failed'
    )
  )
  OR (NEW.status = 'timed_out' AND NEW.failure_code = 'run.timed_out')
  OR (NEW.status = 'interrupted' AND NEW.failure_code = 'run.interrupted')
  OR (
    NEW.status IN ('queued', 'starting', 'running', 'cancelling', 'succeeded', 'cancelled')
    AND NEW.failure_code IS NULL
  )
), 0) = 0
BEGIN
  SELECT RAISE(ABORT, 'invalid_agent_run_failure_code');
END;

CREATE TRIGGER IF NOT EXISTS agent_runs_validate_failure_code_update
BEFORE UPDATE OF status, failure_code ON agent_runs
WHEN COALESCE((
  (
    NEW.status = 'failed'
    AND NEW.failure_code IN (
      'run.start_failed',
      'run.sandbox_failed',
      'run.agent_protocol_failed',
      'run.agent_process_failed',
      'run.model_failed',
      'run.no_visible_reply',
      'run.internal_failed'
    )
  )
  OR (NEW.status = 'timed_out' AND NEW.failure_code = 'run.timed_out')
  OR (NEW.status = 'interrupted' AND NEW.failure_code = 'run.interrupted')
  OR (
    NEW.status IN ('queued', 'starting', 'running', 'cancelling', 'succeeded', 'cancelled')
    AND NEW.failure_code IS NULL
  )
), 0) = 0
BEGIN
  SELECT RAISE(ABORT, 'invalid_agent_run_failure_code');
END;

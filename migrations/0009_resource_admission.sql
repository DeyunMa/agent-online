-- Bounded execution admission counters, not a usage or billing ledger.
-- UTC windows use the database clock; deleting a Project never resets them.
CREATE TABLE user_resource_counters (
  user_id TEXT PRIMARY KEY REFERENCES user (id) ON DELETE CASCADE,
  admission_hour INTEGER NOT NULL DEFAULT 0,
  admission_count INTEGER NOT NULL DEFAULT 0
    CONSTRAINT user_resource_admission_rate CHECK (admission_count BETWEEN 0 AND 60),
  model_day INTEGER NOT NULL DEFAULT 0,
  model_count INTEGER NOT NULL DEFAULT 0
    CONSTRAINT user_resource_model_budget CHECK (model_count BETWEEN 0 AND 512)
);

ALTER TABLE agent_runs ADD COLUMN model_admission_count INTEGER NOT NULL DEFAULT 0
  CHECK (model_admission_count BETWEEN 0 AND 64);
ALTER TABLE agent_runs ADD COLUMN model_request_active INTEGER NOT NULL DEFAULT 0
  CHECK (model_request_active IN (0, 1));

CREATE TRIGGER agent_runs_resource_admission
AFTER INSERT ON agent_runs
WHEN NEW.status IN ('queued', 'starting', 'running', 'cancelling')
BEGIN
  SELECT CASE WHEN (
    (SELECT COUNT(*) FROM agent_runs WHERE user_id = NEW.user_id
      AND status IN ('queued', 'starting', 'running', 'cancelling')) +
    (SELECT COUNT(*) FROM terminal_sessions JOIN projects ON projects.id = terminal_sessions.project_id
      WHERE projects.user_id = NEW.user_id)
  ) > 2 THEN RAISE(ABORT, 'user_resource_concurrency') END;
  INSERT INTO user_resource_counters (user_id, admission_hour, admission_count)
    VALUES (NEW.user_id, CAST(strftime('%s', 'now') AS INTEGER) / 3600, 1)
    ON CONFLICT(user_id) DO UPDATE SET
      admission_count = CASE WHEN admission_hour = excluded.admission_hour THEN admission_count + 1 ELSE 1 END,
      admission_hour = excluded.admission_hour;
END;

CREATE TRIGGER terminal_sessions_resource_admission
AFTER INSERT ON terminal_sessions
BEGIN
  SELECT CASE WHEN (
    (SELECT COUNT(*) FROM agent_runs WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
      AND status IN ('queued', 'starting', 'running', 'cancelling')) +
    (SELECT COUNT(*) FROM terminal_sessions JOIN projects ON projects.id = terminal_sessions.project_id
      WHERE projects.user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id))
  ) > 2 THEN RAISE(ABORT, 'user_resource_concurrency') END;
  INSERT INTO user_resource_counters (user_id, admission_hour, admission_count)
    VALUES ((SELECT user_id FROM projects WHERE id = NEW.project_id), CAST(strftime('%s', 'now') AS INTEGER) / 3600, 1)
    ON CONFLICT(user_id) DO UPDATE SET
      admission_count = CASE WHEN admission_hour = excluded.admission_hour THEN admission_count + 1 ELSE 1 END,
      admission_hour = excluded.admission_hour;
  -- The outer Terminal INSERT OR IGNORE must not suppress a counter constraint.
  SELECT CASE WHEN changes() = 0 THEN RAISE(ABORT, 'user_resource_admission_rate') END;
END;

CREATE TRIGGER agent_runs_model_admission
BEFORE UPDATE OF model_admission_count ON agent_runs
WHEN NEW.model_admission_count > OLD.model_admission_count
BEGIN
  INSERT INTO user_resource_counters (user_id, model_day, model_count)
    VALUES (NEW.user_id, CAST(strftime('%s', 'now') AS INTEGER) / 86400, 1)
    ON CONFLICT(user_id) DO UPDATE SET
      model_count = CASE WHEN model_day = excluded.model_day THEN model_count + 1 ELSE 1 END,
      model_day = excluded.model_day;
END;

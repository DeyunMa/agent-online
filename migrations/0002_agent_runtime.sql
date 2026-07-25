ALTER TABLE projects ADD COLUMN default_agent_runtime_id TEXT NOT NULL DEFAULT 'pi';

ALTER TABLE runs ADD COLUMN agent_runtime_id TEXT NOT NULL DEFAULT 'pi';

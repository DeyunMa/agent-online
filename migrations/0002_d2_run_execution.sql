CREATE UNIQUE INDEX IF NOT EXISTS messages_one_assistant_per_run
  ON messages (agent_run_id)
  WHERE role = 'assistant' AND agent_run_id IS NOT NULL;

SELECT 'active_agent_runs' AS check_name, COUNT(*) AS issue_count
FROM agent_runs
WHERE status IN ('queued', 'starting', 'running', 'cancelling')
UNION ALL
SELECT 'terminal_sessions', COUNT(*)
FROM terminal_sessions
UNION ALL
SELECT 'preview_sessions', COUNT(*)
FROM preview_sessions
UNION ALL
SELECT 'agent_run_ownership_mismatches', COUNT(*)
FROM agent_runs
WHERE NOT EXISTS (
  SELECT 1
  FROM projects
  INNER JOIN sandbox_leases
    ON sandbox_leases.id = agent_runs.sandbox_lease_id
   AND sandbox_leases.project_id = projects.id
   AND sandbox_leases.sandbox_runtime_id = agent_runs.sandbox_runtime_id
  WHERE projects.id = agent_runs.project_id
    AND projects.user_id = agent_runs.user_id
)
UNION ALL
SELECT 'agent_run_input_message_mismatches', COUNT(*)
FROM agent_runs
WHERE input_message_id IS NULL
   OR NOT EXISTS (
     SELECT 1
     FROM messages
     WHERE messages.id = agent_runs.input_message_id
       AND messages.project_id = agent_runs.project_id
       AND messages.role = 'user'
       AND messages.agent_run_id IS NULL
   );

SELECT 'message_agent_link_mismatches' AS check_name, COUNT(*) AS issue_count
FROM messages
WHERE (
  role = 'user'
  AND agent_run_id IS NOT NULL
)
OR (
  role = 'assistant'
  AND (
    agent_run_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM agent_runs
      WHERE agent_runs.id = messages.agent_run_id
        AND agent_runs.project_id = messages.project_id
        AND agent_runs.status = 'succeeded'
    )
  )
)
UNION ALL
SELECT 'terminal_lease_mismatches', COUNT(*)
FROM terminal_sessions
WHERE NOT EXISTS (
  SELECT 1
  FROM sandbox_leases
  WHERE sandbox_leases.id = terminal_sessions.sandbox_lease_id
    AND sandbox_leases.project_id = terminal_sessions.project_id
)
UNION ALL
SELECT 'preview_lease_mismatches', COUNT(*)
FROM preview_sessions
WHERE NOT EXISTS (
  SELECT 1
  FROM sandbox_leases
  WHERE sandbox_leases.id = preview_sessions.sandbox_lease_id
    AND sandbox_leases.project_id = preview_sessions.project_id
    AND sandbox_leases.provider_ref = preview_sessions.provider_sandbox_ref
);

SELECT 'foreign_key_violations' AS check_name, COUNT(*) AS issue_count
FROM pragma_foreign_key_check;

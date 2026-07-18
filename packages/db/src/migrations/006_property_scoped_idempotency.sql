ALTER TABLE command_executions
  DROP CONSTRAINT command_executions_subject_id_command_type_idempotency_key_key;

ALTER TABLE command_executions
  ADD CONSTRAINT command_executions_idempotency_scope_key
  UNIQUE (subject_id, property_id, command_type, idempotency_key);

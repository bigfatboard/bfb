-- ABOUTME: Adds D02 delivery covering indexes for bounded turn scheduling and causal input reads.
-- ABOUTME: Changes no D01 record, constraint, or trigger; D01's delivery state machine remains the write authority.

CREATE INDEX discussion_deliveries_d02_schedule
  ON discussion_deliveries (workspace_id, discussion_id, state);

CREATE INDEX discussion_turns_d02_schedule
  ON discussion_turns (workspace_id, discussion_id, state, ordinal);

CREATE INDEX discussion_messages_d02_inputs
  ON discussion_messages (workspace_id, discussion_id, kind);

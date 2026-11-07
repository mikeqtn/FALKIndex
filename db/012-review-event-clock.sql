-- A submission's history is read in created_at order. now() is the time the transaction began, so two entries
-- written in one transaction (a question and its answer in a test, or any future multi-step action) tied and fell
-- back to the random id. clock_timestamp() is the moment each entry is written. Existing rows are unchanged.
ALTER TABLE falk_review_event ALTER COLUMN created_at SET DEFAULT clock_timestamp();

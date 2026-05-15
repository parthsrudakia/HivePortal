-- A run starts in "preview" state and only writes to the payments table
-- after the operator explicitly clicks Post payments. posted_at is the
-- timestamp of that confirmation; null means still preview.
alter table reconciliation_runs
  add column posted_at timestamptz;

-- Fix: reconciliation "Post payments" silently wrote nothing.
--
-- postPayments() upserts with onConflict: "external_ref". PostgREST emits
-- ON CONFLICT (external_ref), which can only use a unique index as the
-- arbiter if Postgres can *infer* it. The previous index was PARTIAL
-- (WHERE external_ref IS NOT NULL), and a partial index can only be
-- inferred when the statement repeats its predicate -- which PostgREST
-- can't supply. So every upsert failed with 42P10, the loop swallowed the
-- error and continued, and the run was still marked posted: success with
-- zero payments written.
--
-- A plain (non-partial) unique index still permits multiple NULL
-- external_refs (NULLs are distinct in a unique index), so manual payments
-- are unaffected -- but ON CONFLICT (external_ref) can now match it.

drop index if exists payments_external_ref_unique;

create unique index payments_external_ref_unique
  on payments (external_ref);

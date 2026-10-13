-- Where a utility statement came from, as reported by the statements agent
-- (POST /api/utilities/statements): 'pseg' | 'coned' | 'other'. Lets the
-- coverage endpoint answer "what's logged per provider" for the agent's
-- weekly per-provider runs. Null = portal upload / manual entry with no
-- known source. Existing PSE&G / Con Edison bills are backfilled from the
-- extracted provider name.

alter table public.utility_bills
  add column source text
  constraint utility_bills_source_check check (source in ('pseg', 'coned', 'other'));

update public.utility_bills set source = 'pseg' where provider = 'PSE&G';
update public.utility_bills set source = 'coned' where provider = 'Con Edison';

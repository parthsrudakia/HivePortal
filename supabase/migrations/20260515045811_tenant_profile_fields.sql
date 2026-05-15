-- Tenant profile fields: shown on per-apartment "Residents" widget so the
-- operator (and cleaners reading email digests) can recognise who lives where.
alter table tenants
  add column age integer,
  add column profession text,
  add column linkedin_url text,
  add column instagram_url text;

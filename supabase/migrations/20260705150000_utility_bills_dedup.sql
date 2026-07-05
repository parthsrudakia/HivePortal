-- Duplicate-statement guard: uploads carry the file's SHA-256 so the exact
-- same file can't be logged twice (re-scans of the same bill are caught
-- separately by account + billing period in the upload action).
alter table public.utility_bills add column if not exists file_sha256 text;
create unique index if not exists utility_bills_file_sha256_key
  on public.utility_bills (file_sha256) where file_sha256 is not null;

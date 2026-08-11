-- Manual bill entry no longer requires a screenshot: a manually-typed bill
-- may have no stored statement. Reads already handle the null (the UI shows
-- "No statement on file.").
alter table utility_bills alter column statement_path drop not null;

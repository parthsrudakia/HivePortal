-- New York apartments get personal, unbranded correspondence: notification
-- emails (rent / balance reminders, agreements) are sent from the personal
-- Gmail account, plain-text, with no Hive branding. The owner marks a unit as
-- New York via a checkbox on the property page. Opt-in (default false).
alter table properties
  add column is_new_york boolean not null default false;

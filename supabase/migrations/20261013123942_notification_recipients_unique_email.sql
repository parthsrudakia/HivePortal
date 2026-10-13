-- One notification-recipient row per person: the same portal user (email,
-- case-insensitive) can't be added twice. A second row for the same person
-- double-sends every room-change email and splits their ad tally on
-- /inventory.
create unique index notification_recipients_email_unique
  on public.notification_recipients (lower(email));

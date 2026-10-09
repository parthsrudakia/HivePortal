-- Emergency-contact form links are valid for 48 hours from the send. Set on
-- every send (with a fresh token); null = never sent, so the link is dead.
-- After expiry the form neither shows nor saves; a resend rotates the token.
alter table emergency_contacts add column expires_at timestamptz;
grant select (expires_at) on public.emergency_contacts to bot_readonly;

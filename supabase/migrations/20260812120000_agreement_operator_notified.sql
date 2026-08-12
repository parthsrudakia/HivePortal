-- Telegram signing alerts are retried until delivered: the signing action
-- stamps operator_notified_at only after Telegram confirms the send, and the
-- daily ops cron re-sends for any signed row still unstamped.
alter table agreement_requests
  add column operator_notified_at timestamptz;

-- Rows signed before this feature existed were already handled — stamp them
-- so the first sweep doesn't fire a pile of stale alerts.
update agreement_requests
  set operator_notified_at = coalesce(signed_at, now())
  where status = 'signed';

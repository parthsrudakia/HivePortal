-- The room is a mandatory part of every agreement: the PDF names it, the
-- tally shows it, and Add Tenant from a signed agreement prefills it. room_id
-- points at the portal room the send was validated against (the room must
-- belong to the agreement's property); room_number is the label as printed,
-- kept even if the room row is later deleted or renumbered. Both are nullable
-- only because requests sent before this migration have neither — every new
-- send sets both (enforced in sendAgreementRequest).
alter table agreement_requests
  add column room_id uuid references rooms(id) on delete set null,
  add column room_number text;

create index agreement_requests_room_id_idx on agreement_requests (room_id);

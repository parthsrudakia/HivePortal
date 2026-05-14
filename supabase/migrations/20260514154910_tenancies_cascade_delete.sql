-- Allow property/tenant deletion to cascade through tenancies.
-- The original schema used ON DELETE RESTRICT on tenancies.room_id and
-- tenancies.tenant_id, which silently blocked /properties delete because
-- rooms could not cascade-remove their tenancies.
alter table tenancies
  drop constraint tenancies_room_id_fkey,
  drop constraint tenancies_tenant_id_fkey,
  add constraint tenancies_room_id_fkey
    foreign key (room_id) references rooms(id) on delete cascade,
  add constraint tenancies_tenant_id_fkey
    foreign key (tenant_id) references tenants(id) on delete cascade;

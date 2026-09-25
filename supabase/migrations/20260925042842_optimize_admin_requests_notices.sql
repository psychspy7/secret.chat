create index room_deletion_requested_by_idx
  on public.room_deletion_requests(requested_by);
create index room_deletion_reviewed_by_idx
  on public.room_deletion_requests(reviewed_by);

drop policy if exists notices_public_read on public.site_notices;
drop policy if exists notices_admin_read on public.site_notices;
create policy notices_public_read on public.site_notices for select
  to anon using (is_active);
create policy notices_authenticated_read on public.site_notices for select
  to authenticated using (is_active or (select app_private.is_admin()));

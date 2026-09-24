-- Advisor follow-up: covering indexes and consolidated room SELECT policy.
create index rooms_host_user_id_idx on public.rooms(host_user_id);
create index room_members_user_id_idx on public.room_members(user_id);
create index messages_sender_id_idx on public.messages(sender_id);

drop policy hosts_read_self on public.hosts;
create policy hosts_read_self on public.hosts for select to authenticated
using ((select auth.uid()) = user_id and (select coalesce((auth.jwt()->>'is_anonymous')::boolean, false)) is false);

drop policy rooms_host_all on public.rooms;
drop policy rooms_member_read on public.rooms;
create policy rooms_authorized_read on public.rooms for select to authenticated
using (
  ((select auth.uid()) = host_user_id and (select coalesce((auth.jwt()->>'is_anonymous')::boolean, false)) is false)
  or (select app_private.is_room_member(id, false))
);
create policy rooms_host_insert on public.rooms for insert to authenticated
with check ((select auth.uid()) = host_user_id and (select coalesce((auth.jwt()->>'is_anonymous')::boolean, false)) is false);
create policy rooms_host_update on public.rooms for update to authenticated
using ((select auth.uid()) = host_user_id and (select coalesce((auth.jwt()->>'is_anonymous')::boolean, false)) is false)
with check ((select auth.uid()) = host_user_id and (select coalesce((auth.jwt()->>'is_anonymous')::boolean, false)) is false);
create policy rooms_host_delete on public.rooms for delete to authenticated
using ((select auth.uid()) = host_user_id and (select coalesce((auth.jwt()->>'is_anonymous')::boolean, false)) is false);

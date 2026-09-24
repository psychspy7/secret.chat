-- A former participant may read closure metadata briefly so Realtime can deliver
-- the closed-room update. Message and member access still stops immediately.
drop policy if exists rooms_authorized_read on public.rooms;
create policy rooms_authorized_read on public.rooms for select to authenticated
using (
  host_user_id=(select auth.uid())
  or (select app_private.is_admin())
  or app_private.can_read_room(id)
  or (closed_at>now()-interval '2 minutes'
    and app_private.is_room_member(id,false))
);

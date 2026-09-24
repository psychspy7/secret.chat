-- Members may update presence/name fields only; room_id and user_id stay immutable.
revoke update on public.room_members from authenticated;
grant update(name_cipher, is_active, last_seen) on public.room_members to authenticated;

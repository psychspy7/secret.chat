-- The RETURNS TABLE output name room_id is also a PL/pgSQL variable, so target
-- the named constraint instead of an ambiguous column list.
create or replace function public.join_room(p_code_hash text, p_key_hash text, p_name_cipher jsonb)
returns table(room_id uuid, label_cipher jsonb, host_user_id uuid)
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_room public.rooms%rowtype; v_uid uuid := auth.uid(); v_anon boolean;
begin
  if v_uid is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_code_hash !~ '^[0-9a-f]{64}$' or p_key_hash !~ '^[0-9a-f]{64}$' or pg_column_size(p_name_cipher) > 2048 then
    raise exception 'invalid room credentials' using errcode='22023';
  end if;
  select * into v_room from public.rooms r where r.code_hash=p_code_hash and r.key_hash=p_key_hash and r.is_active limit 1;
  if not found then raise exception 'room unavailable' using errcode='P0002'; end if;
  v_anon := coalesce((auth.jwt()->>'is_anonymous')::boolean, false);
  if not v_anon and v_room.host_user_id <> v_uid then raise exception 'room unavailable' using errcode='42501'; end if;
  insert into public.room_members(room_id,user_id,name_cipher,is_active,joined_at,last_seen)
  values(v_room.id,v_uid,p_name_cipher,true,now(),now())
  on conflict on constraint room_members_pkey do update set
    name_cipher=excluded.name_cipher,is_active=true,joined_at=now(),last_seen=now();
  return query select v_room.id,v_room.label_cipher,v_room.host_user_id;
end $$;

revoke all on function public.join_room(text,text,jsonb) from public, anon;
grant execute on function public.join_room(text,text,jsonb) to authenticated;

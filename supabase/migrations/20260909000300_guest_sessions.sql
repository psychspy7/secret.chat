-- Allow short-lived Kitty guest accounts created by the guest-session Edge Function.
create table app_private.guest_attempts (
  ip_hash text primary key check (ip_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null default now(),
  attempts integer not null default 1 check (attempts > 0),
  last_seen_at timestamptz not null default now()
);

revoke all on app_private.guest_attempts from public, anon, authenticated;

create or replace function public.consume_guest_attempt(p_ip_hash text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, app_private
as $$
declare
  v_attempts integer;
begin
  if p_ip_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  insert into app_private.guest_attempts(ip_hash, window_started_at, attempts, last_seen_at)
  values (p_ip_hash, now(), 1, now())
  on conflict (ip_hash) do update set
    attempts = case
      when app_private.guest_attempts.window_started_at < now() - interval '1 minute' then 1
      else app_private.guest_attempts.attempts + 1
    end,
    window_started_at = case
      when app_private.guest_attempts.window_started_at < now() - interval '1 minute' then now()
      else app_private.guest_attempts.window_started_at
    end,
    last_seen_at = now()
  returning attempts into v_attempts;

  delete from app_private.guest_attempts
  where last_seen_at < now() - interval '1 day';

  return v_attempts <= 12;
end
$$;

revoke all on function public.consume_guest_attempt(text) from public, anon, authenticated;
grant execute on function public.consume_guest_attempt(text) to service_role;

create or replace function public.join_room(p_code_hash text, p_key_hash text, p_name_cipher jsonb)
returns table(room_id uuid, label_cipher jsonb, host_user_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_room public.rooms%rowtype;
  v_uid uuid := auth.uid();
  v_guest boolean;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode='28000';
  end if;
  if p_code_hash !~ '^[0-9a-f]{64}$'
     or p_key_hash !~ '^[0-9a-f]{64}$'
     or pg_column_size(p_name_cipher) > 2048 then
    raise exception 'invalid room credentials' using errcode='22023';
  end if;

  select * into v_room
  from public.rooms r
  where r.code_hash=p_code_hash and r.key_hash=p_key_hash and r.is_active
  limit 1;
  if not found then
    raise exception 'room unavailable' using errcode='P0002';
  end if;

  v_guest := coalesce((auth.jwt()->>'is_anonymous')::boolean, false)
    or coalesce((auth.jwt()->'app_metadata'->>'kitty_guest')::boolean, false);
  if not v_guest and v_room.host_user_id <> v_uid then
    raise exception 'room unavailable' using errcode='42501';
  end if;

  insert into public.room_members(room_id,user_id,name_cipher,is_active,joined_at,last_seen)
  values(v_room.id,v_uid,p_name_cipher,true,now(),now())
  on conflict (room_id,user_id) do update set
    name_cipher=excluded.name_cipher,
    is_active=true,
    joined_at=now(),
    last_seen=now();

  return query select v_room.id,v_room.label_cipher,v_room.host_user_id;
end
$$;

revoke all on function public.join_room(text,text,jsonb) from public, anon;
grant execute on function public.join_room(text,text,jsonb) to authenticated;

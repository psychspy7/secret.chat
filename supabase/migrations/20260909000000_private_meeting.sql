-- Kitty Corp Private Meeting v2. Run once in a fresh Supabase project.
create extension if not exists pgcrypto;

create table public.hosts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  host_id text unique not null check (host_id ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
  vault_salt text not null check (length(vault_salt) between 20 and 128),
  created_at timestamptz not null default now()
);

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  host_user_id uuid not null references public.hosts(user_id) on delete cascade,
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  label_cipher jsonb not null,
  host_key_cipher jsonb not null,
  chat_epoch integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create unique index rooms_one_active_code on public.rooms(code_hash) where is_active;

create table public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name_cipher jsonb not null,
  is_active boolean not null default true,
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index room_members_room_active on public.room_members(room_id, is_active, last_seen desc);

create table public.messages (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  body_cipher jsonb not null,
  created_at timestamptz not null default now()
);
create index messages_room_created on public.messages(room_id, created_at, id);

alter table public.hosts enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.messages enable row level security;

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;
create or replace function app_private.is_room_member(p_room_id uuid, p_active_only boolean default false)
returns boolean language sql stable security definer set search_path=pg_catalog,public
as $$ select exists(select 1 from public.room_members m where m.room_id=p_room_id and m.user_id=auth.uid() and (not p_active_only or m.is_active)) $$;
create or replace function app_private.is_room_host(p_room_id uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public
as $$ select exists(select 1 from public.rooms r where r.id=p_room_id and r.host_user_id=auth.uid()) $$;
revoke all on function app_private.is_room_member(uuid,boolean), app_private.is_room_host(uuid) from public, anon;
grant usage on schema app_private to authenticated;
grant execute on function app_private.is_room_member(uuid,boolean), app_private.is_room_host(uuid) to authenticated;

create policy hosts_read_self on public.hosts for select to authenticated
using ((select auth.uid()) = user_id and coalesce((select (auth.jwt()->>'is_anonymous')::boolean), false) is false);

create policy rooms_host_all on public.rooms for all to authenticated
using ((select auth.uid()) = host_user_id and coalesce((select (auth.jwt()->>'is_anonymous')::boolean), false) is false)
with check ((select auth.uid()) = host_user_id and coalesce((select (auth.jwt()->>'is_anonymous')::boolean), false) is false);
create policy rooms_member_read on public.rooms for select to authenticated
using ((select app_private.is_room_member(id, false)));

create policy members_room_read on public.room_members for select to authenticated
using (
  user_id = (select auth.uid()) or
  (select app_private.is_room_host(room_id)) or
  (select app_private.is_room_member(room_id, true))
);
create policy members_update_self on public.room_members for update to authenticated
using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy messages_room_read on public.messages for select to authenticated
using (
  (select app_private.is_room_host(room_id)) or
  (select app_private.is_room_member(room_id, true))
);

grant usage on schema public to authenticated;
grant select on public.hosts to authenticated;
grant select, insert, update, delete on public.rooms to authenticated;
grant select, update on public.room_members to authenticated;
grant select on public.messages to authenticated;
revoke all on public.hosts, public.rooms, public.room_members, public.messages from anon;

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
  on conflict (room_id,user_id) do update set name_cipher=excluded.name_cipher,is_active=true,joined_at=now(),last_seen=now();
  return query select v_room.id,v_room.label_cipher,v_room.host_user_id;
end $$;

create or replace function public.send_message(p_room_id uuid, p_body_cipher jsonb)
returns bigint language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_uid uuid := auth.uid(); v_id bigint;
begin
  if v_uid is null or pg_column_size(p_body_cipher)>12000 then raise exception 'invalid message' using errcode='22023'; end if;
  if not exists(select 1 from public.rooms r where r.id=p_room_id and r.is_active and (r.host_user_id=v_uid or exists(select 1 from public.room_members m where m.room_id=r.id and m.user_id=v_uid and m.is_active))) then
    raise exception 'room unavailable' using errcode='42501';
  end if;
  if (select count(*) from public.messages m where m.room_id=p_room_id and m.sender_id=v_uid and m.created_at>now()-interval '5 seconds') >= 5 then
    raise exception 'please slow down' using errcode='P0001';
  end if;
  insert into public.messages(room_id,sender_id,body_cipher) values(p_room_id,v_uid,p_body_cipher) returning id into v_id;
  return v_id;
end $$;

create or replace function public.clear_room_messages(p_room_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public
as $$ begin
  if not exists(select 1 from public.rooms r where r.id=p_room_id and r.host_user_id=auth.uid() and coalesce((auth.jwt()->>'is_anonymous')::boolean,false) is false) then raise exception 'forbidden' using errcode='42501'; end if;
  delete from public.messages where room_id=p_room_id;
  update public.rooms set chat_epoch=chat_epoch+1 where id=p_room_id;
end $$;

create or replace function public.close_room(p_room_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public
as $$ begin
  if not exists(select 1 from public.rooms r where r.id=p_room_id and r.host_user_id=auth.uid() and coalesce((auth.jwt()->>'is_anonymous')::boolean,false) is false) then raise exception 'forbidden' using errcode='42501'; end if;
  delete from public.messages where room_id=p_room_id;
  update public.room_members set is_active=false,name_cipher='{"v":0}'::jsonb,last_seen=now() where room_id=p_room_id;
  update public.rooms set is_active=false,closed_at=now(),chat_epoch=chat_epoch+1 where id=p_room_id;
end $$;

revoke all on function public.join_room(text,text,jsonb) from public, anon;
revoke all on function public.send_message(uuid,jsonb) from public, anon;
revoke all on function public.clear_room_messages(uuid) from public, anon;
revoke all on function public.close_room(uuid) from public, anon;
grant execute on function public.join_room(text,text,jsonb) to authenticated;
grant execute on function public.send_message(uuid,jsonb) to authenticated;
grant execute on function public.clear_room_messages(uuid) to authenticated;
grant execute on function public.close_room(uuid) to authenticated;

alter table public.room_members replica identity full;
alter table public.messages replica identity full;
alter table public.rooms replica identity full;
alter publication supabase_realtime add table public.rooms, public.room_members, public.messages;

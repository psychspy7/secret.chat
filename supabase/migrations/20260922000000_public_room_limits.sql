-- SideChat public rooms. Quotas and expiry are enforced in Postgres, not the UI.
alter table public.hosts add column if not exists public_key_jwk jsonb,
  add column if not exists private_key_cipher jsonb;
alter table public.rooms add column if not exists is_public_created boolean not null default false,
  add column if not exists expires_at timestamptz;
alter table public.rooms drop constraint if exists rooms_host_user_id_fkey;
alter table public.rooms add constraint rooms_host_user_id_fkey
  foreign key(host_user_id) references auth.users(id) on delete cascade;

create index if not exists rooms_owner_created_idx on public.rooms(host_user_id,created_at desc);
create index if not exists rooms_public_expiry_idx on public.rooms(expires_at) where is_public_created;
create index if not exists messages_room_id_idx on public.messages(room_id,id desc);

create or replace function app_private.is_admin()
returns boolean language sql stable security definer set search_path=''
as $$ select auth.uid() is not null and exists(
  select 1 from public.hosts where user_id=auth.uid()
) and coalesce((auth.jwt()->>'is_anonymous')::boolean,false) is false $$;

create or replace function app_private.can_read_room(p_room_id uuid)
returns boolean language sql stable security definer set search_path=''
as $$
  select exists(select 1 from public.rooms r where r.id=p_room_id and r.is_active
    and (r.expires_at is null or r.expires_at>now())
    and (r.host_user_id=auth.uid() or app_private.is_admin()
      or exists(select 1 from public.room_members m where m.room_id=r.id
        and m.user_id=auth.uid() and m.is_active)))
$$;

create or replace function app_private.valid_cipher(p_cipher jsonb,p_max_bytes integer)
returns boolean language sql immutable set search_path=''
as $$
  select coalesce(jsonb_typeof(p_cipher)='object'
    and p_cipher->>'v'='2'
    and p_cipher->>'iv' ~ '^[A-Za-z0-9_-]{16}$'
    and p_cipher->>'data' ~ '^[A-Za-z0-9_-]{22,16000}$'
    and octet_length(p_cipher::text)<=p_max_bytes,false)
$$;

-- Cleanup is available to the scheduled job; normal traffic also invokes it.
-- Access checks reject expired rooms even when this cleanup has not run yet.
create or replace function app_private.expire_public_rooms()
returns void language plpgsql security definer set search_path=''
as $$
declare v_id uuid;
begin
  for v_id in select r.id from public.rooms r
    where r.is_active and r.is_public_created and r.expires_at<=now()
    order by r.id for update skip locked
  loop
    update public.rooms set is_active=false,closed_at=now(),chat_epoch=chat_epoch+1 where id=v_id;
    delete from public.messages where room_id=v_id;
    update public.room_members set is_active=false,name_cipher='{"v":0}',last_seen=now() where room_id=v_id;
  end loop;
  -- Quota history survives for 7 days, well beyond the daily limit window.
  delete from public.rooms where is_public_created and not is_active
    and created_at<now()-interval '7 days';
end $$;

revoke all on function app_private.is_admin(),app_private.can_read_room(uuid),
  app_private.valid_cipher(jsonb,integer),app_private.expire_public_rooms() from public,anon,authenticated;
grant execute on function app_private.is_admin(),app_private.can_read_room(uuid) to authenticated;

drop policy if exists rooms_authorized_read on public.rooms;
drop policy if exists rooms_host_insert on public.rooms;
drop policy if exists rooms_host_update on public.rooms;
drop policy if exists rooms_host_delete on public.rooms;
create policy rooms_authorized_read on public.rooms for select to authenticated using(
  host_user_id=(select auth.uid()) or (select app_private.is_admin())
  or app_private.can_read_room(id)
);
drop policy if exists members_room_read on public.room_members;
create policy members_room_read on public.room_members for select to authenticated
  using(app_private.can_read_room(room_id));
drop policy if exists messages_room_read on public.messages;
create policy messages_room_read on public.messages for select to authenticated
  using(app_private.can_read_room(room_id));
drop policy if exists members_update_self on public.room_members;
revoke insert,update,delete on public.rooms from authenticated;
revoke update on public.room_members from authenticated;
revoke update(name_cipher,is_active,last_seen) on public.room_members from authenticated;

create or replace function public.get_host_public_key()
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare v_key jsonb;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='28000'; end if;
  select public_key_jwk into v_key from public.hosts
    where public_key_jwk is not null order by created_at,user_id limit 1;
  if v_key is null then raise exception 'host encryption is not ready'; end if;
  return v_key;
end $$;

-- Provision once. Replacing the private key would make existing rooms unreadable.
create or replace function public.set_host_keypair(p_public_key_jwk jsonb,p_private_key_cipher jsonb)
returns void language plpgsql security definer set search_path=''
as $$
begin
  if not app_private.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
  if not coalesce(p_public_key_jwk->>'kty'='RSA'
    and p_public_key_jwk->>'e'='AQAB'
    and p_public_key_jwk->>'n' ~ '^[A-Za-z0-9_-]{342}$'
    and not (p_public_key_jwk ?| array['d','p','q','dp','dq','qi'])
    and octet_length(p_public_key_jwk::text)<2048,false)
    or not app_private.valid_cipher(p_private_key_cipher,12000)
  then raise exception 'invalid key data'; end if;
  update public.hosts set public_key_jwk=p_public_key_jwk,private_key_cipher=p_private_key_cipher
    where user_id=auth.uid() and public_key_jwk is null and private_key_cipher is null;
  if not found then raise exception 'host key already provisioned'; end if;
end $$;

create or replace function public.create_room(p_code_hash text,p_key_hash text,p_label_cipher jsonb,p_host_key_cipher jsonb)
returns setof public.rooms language plpgsql security definer set search_path=''
as $$
declare v_uid uuid:=auth.uid(); v_admin boolean; v_room public.rooms;
begin
  if v_uid is null then raise exception 'authentication required' using errcode='28000'; end if;
  if not coalesce(p_code_hash ~ '^[0-9a-f]{64}$' and p_key_hash ~ '^[0-9a-f]{64}$',false)
    or not app_private.valid_cipher(p_label_cipher,2048)
  then raise exception 'invalid room data'; end if;
  v_admin:=app_private.is_admin();
  if not (v_admin and app_private.valid_cipher(p_host_key_cipher,2048))
    and not coalesce(p_host_key_cipher->>'v'='3' and p_host_key_cipher->>'alg'='RSA-OAEP-256'
      and p_host_key_cipher->>'data' ~ '^[A-Za-z0-9_-]{342}$'
      and octet_length(p_host_key_cipher::text)<1024,false)
  then raise exception 'invalid wrapped room key'; end if;
  if not v_admin and not exists(select 1 from public.hosts where public_key_jwk is not null)
    then raise exception 'host encryption is not ready'; end if;
  -- Serialize creation, including the global ceiling, to prevent concurrent quota bypass.
  perform pg_advisory_xact_lock(73190223);
  perform app_private.expire_public_rooms();
  if not v_admin then
    if (select count(*) from public.rooms r where r.host_user_id=v_uid and r.is_active)>=3
      then raise exception 'active room limit reached'; end if;
    if (select count(*) from public.rooms r where r.host_user_id=v_uid and r.created_at>now()-interval '24 hours')>=10
      then raise exception 'daily room limit reached'; end if;
    if (select count(*) from public.rooms r where r.is_public_created and r.is_active)>=50
      then raise exception 'service capacity reached; try again later'; end if;
    if (select count(*) from public.rooms r where r.is_public_created and r.created_at>now()-interval '24 hours')>=200
      then raise exception 'service daily capacity reached; try again later'; end if;
  end if;
  insert into public.rooms(host_user_id,code_hash,key_hash,label_cipher,host_key_cipher,is_public_created,expires_at)
    values(v_uid,p_code_hash,p_key_hash,p_label_cipher,p_host_key_cipher,not v_admin,
      case when v_admin then null else now()+interval '24 hours' end) returning * into v_room;
  return next v_room;
end $$;

create or replace function public.join_room(p_code_hash text,p_key_hash text,p_name_cipher jsonb)
returns table(room_id uuid,label_cipher jsonb,host_user_id uuid)
language plpgsql security definer set search_path=''
as $$
declare v_room public.rooms; v_uid uuid:=auth.uid(); v_member boolean;
begin
  if v_uid is null then raise exception 'authentication required' using errcode='28000'; end if;
  if not coalesce(p_code_hash ~ '^[0-9a-f]{64}$' and p_key_hash ~ '^[0-9a-f]{64}$',false)
    or not app_private.valid_cipher(p_name_cipher,2048) then raise exception 'invalid room credentials'; end if;
  select * into v_room from public.rooms r where r.code_hash=p_code_hash and r.key_hash=p_key_hash
    and r.is_active and (r.expires_at is null or r.expires_at>now()) for update;
  if not found then raise exception 'room unavailable' using errcode='P0002'; end if;
  select exists(select 1 from public.room_members m where m.room_id=v_room.id and m.user_id=v_uid) into v_member;
  if not v_member and (select count(*) from public.room_members m where m.room_id=v_room.id)>=100
    and not app_private.is_admin() then raise exception 'room lifetime participant limit reached'; end if;
  if not exists(select 1 from public.room_members m where m.room_id=v_room.id and m.user_id=v_uid
    and m.is_active and m.last_seen>now()-interval '105 seconds')
    and (select count(*) from public.room_members m where m.room_id=v_room.id
      and m.is_active and m.last_seen>now()-interval '105 seconds')>=20
    and not app_private.is_admin() then raise exception 'room is full; try again later'; end if;
  insert into public.room_members(room_id,user_id,name_cipher,is_active,joined_at,last_seen)
    values(v_room.id,v_uid,p_name_cipher,true,now(),now())
    on conflict on constraint room_members_pkey do update set
      name_cipher=excluded.name_cipher,is_active=true,last_seen=now();
  return query select v_room.id,v_room.label_cipher,v_room.host_user_id;
end $$;

create or replace function public.touch_room(p_room_id uuid,p_leave boolean default false)
returns void language plpgsql security definer set search_path=''
as $$
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  -- A heartbeat cannot reactivate a departed member or bypass join limits.
  update public.room_members m set last_seen=now(),is_active=not p_leave
    where m.room_id=p_room_id and m.user_id=auth.uid() and m.is_active
    and exists(select 1 from public.rooms r where r.id=p_room_id and r.is_active
      and (r.expires_at is null or r.expires_at>now()))
    and (p_leave or m.last_seen<now()-interval '30 seconds');
end $$;

create or replace function public.send_message(p_room_id uuid,p_body_cipher jsonb)
returns bigint language plpgsql security definer set search_path=''
as $$
declare v_uid uuid:=auth.uid(); v_id bigint; v_room public.rooms;
begin
  if v_uid is null or not app_private.valid_cipher(p_body_cipher,12000) then raise exception 'invalid message'; end if;
  -- Serialize writes, clears and closes within a room.
  select * into v_room from public.rooms r where r.id=p_room_id and r.is_active
    and (r.expires_at is null or r.expires_at>now()) for update;
  if not found or not app_private.can_read_room(p_room_id) then raise exception 'room unavailable' using errcode='42501'; end if;
  if (select count(*) from public.messages m where m.room_id=p_room_id and m.sender_id=v_uid
    and m.created_at>now()-interval '5 seconds')>=5 then raise exception 'please slow down'; end if;
  if (select count(*) from public.messages m where m.room_id=p_room_id
    and m.created_at>now()-interval '5 seconds')>=50 then raise exception 'room busy; please slow down'; end if;
  insert into public.messages(room_id,sender_id,body_cipher) values(p_room_id,v_uid,p_body_cipher) returning id into v_id;
  -- Retain exactly the newest 1,000 rows without broadcasting a room update per message.
  delete from public.messages where room_id=p_room_id and id<=(
    select m.id from public.messages m where m.room_id=p_room_id order by m.id desc offset 1000 limit 1
  );
  return v_id;
end $$;

create or replace function public.clear_room_messages(p_room_id uuid)
returns void language plpgsql security definer set search_path=''
as $$
begin
  perform 1 from public.rooms r where r.id=p_room_id
    and (r.host_user_id=auth.uid() or app_private.is_admin()) for update;
  if not found then raise exception 'forbidden' using errcode='42501'; end if;
  delete from public.messages where room_id=p_room_id;
  update public.rooms set chat_epoch=chat_epoch+1 where id=p_room_id;
end $$;

create or replace function public.close_room(p_room_id uuid)
returns void language plpgsql security definer set search_path=''
as $$
begin
  perform 1 from public.rooms r where r.id=p_room_id
    and (r.host_user_id=auth.uid() or app_private.is_admin()) for update;
  if not found then raise exception 'forbidden' using errcode='42501'; end if;
  update public.rooms set is_active=false,closed_at=now(),chat_epoch=chat_epoch+1 where id=p_room_id;
  delete from public.messages where room_id=p_room_id;
  update public.room_members set is_active=false,name_cipher='{"v":0}',last_seen=now() where room_id=p_room_id;
end $$;

revoke all on function public.get_host_public_key(),public.set_host_keypair(jsonb,jsonb),
  public.create_room(text,text,jsonb,jsonb),public.join_room(text,text,jsonb),public.touch_room(uuid,boolean),
  public.send_message(uuid,jsonb),public.clear_room_messages(uuid),public.close_room(uuid) from public,anon,authenticated;
grant execute on function public.get_host_public_key(),public.set_host_keypair(jsonb,jsonb),
  public.create_room(text,text,jsonb,jsonb),public.join_room(text,text,jsonb),public.touch_room(uuid,boolean),
  public.send_message(uuid,jsonb),public.clear_room_messages(uuid),public.close_room(uuid) to authenticated;

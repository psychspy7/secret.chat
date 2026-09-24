create or replace function app_private.valid_cipher(p_cipher jsonb,p_max_bytes integer)
returns boolean language sql immutable set search_path=''
as $$
  select coalesce(jsonb_typeof(p_cipher)='object'
    and p_cipher->>'v'='2'
    and p_cipher->>'iv' ~ '^[A-Za-z0-9_-]{16}$'
    and p_cipher->>'data' ~ '^[A-Za-z0-9_-]+$' and length(p_cipher->>'data') between 22 and 16000
    and octet_length(p_cipher::text)<=p_max_bytes,false)
$$;


create or replace function public.set_host_keypair(p_public_key_jwk jsonb,p_private_key_cipher jsonb)
returns void language plpgsql security definer set search_path=''
as $$
begin
  if not app_private.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
  if not coalesce(p_public_key_jwk->>'kty'='RSA'
    and p_public_key_jwk->>'e'='AQAB'
    and p_public_key_jwk->>'n' ~ '^[A-Za-z0-9_-]+$' and length(p_public_key_jwk->>'n')=342
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
      and p_host_key_cipher->>'data' ~ '^[A-Za-z0-9_-]+$' and length(p_host_key_cipher->>'data')=342
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


-- Supabase Cron enforces deletion even when nobody creates another room.
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create or replace function app_private.sidechat_maintenance()
returns void language plpgsql security definer set search_path=''
as $$
begin
  perform app_private.expire_public_rooms();
  delete from cron.job_run_details d using cron.job j
    where d.jobid=j.jobid and j.jobname='sidechat-expiry'
      and d.end_time<now()-interval '7 days';
end $$;
revoke all on function app_private.sidechat_maintenance() from public,anon,authenticated;
select cron.schedule('sidechat-expiry','*/5 * * * *','select app_private.sidechat_maintenance()');

-- Android v1 is intentionally isolated from the earlier web app.
-- Chat plaintext, ciphertext, invitation codes and room keys are never archived here.
create schema if not exists mobile_private;
revoke all on schema mobile_private from public, anon;
grant usage on schema mobile_private to authenticated, service_role;

create table public.mobile_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(display_name) between 1 and 40),
  last_ip inet, ip_source text,
  disabled boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.mobile_rooms (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique check (code_hash ~ '^[a-f0-9]{64}$'),
  label text not null check(length(label) between 1 and 60),
  created_by uuid not null references public.mobile_profiles(user_id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  closed_at timestamptz
);
create index mobile_rooms_created_by_idx on public.mobile_rooms(created_by,created_at);
create index mobile_rooms_created_at_idx on public.mobile_rooms(created_at);
create table public.mobile_memberships (
  room_id uuid not null references public.mobile_rooms(id) on delete cascade,
  user_id uuid not null references public.mobile_profiles(user_id) on delete cascade,
  watched boolean not null default true,
  joined_at timestamptz not null default now(), last_seen_at timestamptz,
  last_notified_at timestamptz, left_at timestamptz,
  primary key(room_id,user_id)
);
create index mobile_memberships_user_idx on public.mobile_memberships(user_id,room_id);
create table public.mobile_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null unique references public.mobile_rooms(id) on delete cascade,
  requested_by uuid not null references public.mobile_profiles(user_id),
  status text not null default 'pending' check(status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(), reviewed_at timestamptz
);
create index mobile_deletion_requested_by_idx on public.mobile_deletion_requests(requested_by);
create table public.mobile_notices (
  id uuid primary key default gen_random_uuid(),
  title text not null check(length(title) between 1 and 100),
  body text not null check(length(body) between 1 and 3000),
  created_at timestamptz not null default now(), active boolean not null default true
);
create table public.mobile_releases (
  version_code integer primary key check(version_code>0),
  version text not null check(length(version) between 1 and 40),
  apk_url text not null check(apk_url ~ '^https://[^[:space:]]+$' and length(apk_url)<2048),
  sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
  notes text not null check(length(notes)<=3000), created_at timestamptz not null default now()
);
create table mobile_private.rate_limits (
  user_id uuid not null, action text not null, hits timestamptz[] not null default '{}',
  updated_at timestamptz not null default now(), primary key(user_id,action)
);
create table mobile_private.message_receipts (
  message_id uuid primary key, user_id uuid not null,
  created_at timestamptz not null default now()
);
create index mobile_receipts_expiry_idx on mobile_private.message_receipts(created_at);
create table mobile_private.devices (
  token text primary key check(length(token) between 20 and 4096),
  user_id uuid not null references public.mobile_profiles(user_id) on delete cascade,
  updated_at timestamptz not null default now()
);
create index mobile_devices_owner_idx on mobile_private.devices(user_id);
create table mobile_private.push_queue (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.mobile_rooms(id) on delete cascade,
  actor_id uuid not null references public.mobile_profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(), claimed_at timestamptz, completed_at timestamptz
);
create index mobile_push_pending_idx on mobile_private.push_queue(created_at) where completed_at is null;
alter table public.mobile_profiles enable row level security;
alter table public.mobile_rooms enable row level security;
alter table public.mobile_memberships enable row level security;
alter table public.mobile_deletion_requests enable row level security;
alter table public.mobile_notices enable row level security;
alter table public.mobile_releases enable row level security;
alter table mobile_private.rate_limits enable row level security;
alter table mobile_private.message_receipts enable row level security;
alter table mobile_private.devices enable row level security;
alter table mobile_private.push_queue enable row level security;
revoke all on public.mobile_profiles,public.mobile_rooms,public.mobile_memberships,
  public.mobile_deletion_requests,public.mobile_notices,public.mobile_releases from public,anon,authenticated;
revoke all on all tables in schema mobile_private from public,anon,authenticated;

-- The provider identity and email are trusted Auth records, never user_metadata.
-- Revalidate the server session and disabled flag on every privileged operation.
create function mobile_private.require_user() returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or coalesce(auth.jwt()->'app_metadata'->>'provider','') <> 'google'
    or not exists (
      select 1 from auth.users u join auth.identities i on i.user_id=u.id
      where u.id=v_uid and u.email_confirmed_at is not null and u.deleted_at is null
        and (u.banned_until is null or u.banned_until<now())
        and i.provider='google' and lower(i.email)=lower(u.email)
        and i.identity_data->>'email_verified'='true'
    ) or not exists (
      select 1 from auth.sessions s where s.user_id=v_uid
        and s.id::text=auth.jwt()->>'session_id' and (s.not_after is null or s.not_after>now())
    ) then raise exception 'Sign in with your verified Google account.' using errcode='42501'; end if;
  if exists(select 1 from public.mobile_profiles p where p.user_id=v_uid and p.disabled)
    then raise exception 'This account is disabled.' using errcode='42501'; end if;
  return v_uid;
end; $$;
create function mobile_private.is_admin() returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := mobile_private.require_user();
begin
  return exists(select 1 from auth.users u join auth.identities i on i.user_id=u.id
    where u.id=v_uid and lower(u.email)='viratanand1221@gmail.com'
      and i.provider='google' and lower(i.email)='viratanand1221@gmail.com'
      and i.identity_data->>'email_verified'='true');
end; $$;
create function mobile_private.require_admin() returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  if not mobile_private.is_admin() then raise exception 'Administrator access required.' using errcode='42501'; end if;
  return auth.uid();
end; $$;
create function mobile_private.rate_limit(p_uid uuid,p_action text,p_max integer,p_window interval) returns void
language plpgsql security definer set search_path = '' as $$
declare v_hits timestamptz[];
begin
  insert into mobile_private.rate_limits(user_id,action) values(p_uid,p_action) on conflict do nothing;
  select array(select h from unnest(r.hits) h where h>clock_timestamp()-p_window)
    into v_hits from mobile_private.rate_limits r where user_id=p_uid and action=p_action for update;
  if cardinality(v_hits)>=p_max then raise exception 'Please wait before trying again.' using errcode='P0001'; end if;
  update mobile_private.rate_limits set hits=array_append(v_hits,clock_timestamp()),updated_at=now()
    where user_id=p_uid and action=p_action;
end; $$;
create function mobile_private.room_json(p_room_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id',r.id,'label',r.label,'created_by',r.created_by,
    'created_at',r.created_at,'expires_at',r.expires_at,'closed_at',r.closed_at,
    'is_creator',r.created_by=auth.uid(),
    'member_count',(select count(*) from public.mobile_memberships m where m.room_id=r.id),
    'online_count',(select count(*) from public.mobile_memberships m where m.room_id=r.id and m.left_at is null and m.last_seen_at>now()-interval '90 seconds'))
  from public.mobile_rooms r where r.id=p_room_id;
$$;
create function mobile_private.require_member(p_room_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := mobile_private.require_user();
begin
  if not exists(select 1 from public.mobile_memberships m join public.mobile_rooms r on r.id=m.room_id
    where m.room_id=p_room_id and m.user_id=v_uid and r.closed_at is null and r.expires_at>now())
    then raise exception 'This room is unavailable.' using errcode='42501'; end if;
  return v_uid;
end; $$;
create function mobile_private.profile(p_display_name text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := mobile_private.require_user(); v_name text:=trim(p_display_name);
begin
  if v_name is not null and (length(v_name) not between 1 and 40 or v_name ~ '[[:cntrl:]]')
    then raise exception 'Use a name between 1 and 40 characters.'; end if;
  perform mobile_private.rate_limit(v_uid,'profile',30,interval '1 minute');
  insert into public.mobile_profiles(user_id,display_name) values(v_uid,coalesce(v_name,'Member'))
    on conflict(user_id) do update set display_name=coalesce(v_name,mobile_profiles.display_name),updated_at=now();
  return (select jsonb_build_object('user_id',p.user_id,'display_name',p.display_name,'is_admin',mobile_private.is_admin())
    from public.mobile_profiles p where user_id=v_uid);
end; $$;
create function mobile_private.create_room(p_code_hash text,p_label text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := mobile_private.require_user(); v_id uuid; v_label text:=trim(p_label);
begin
  if p_code_hash is null or p_code_hash !~ '^[a-f0-9]{64}$' or v_label is null or length(v_label) not between 1 and 60 or v_label ~ '[[:cntrl:]]'
    then raise exception 'A valid invitation and room name are required.'; end if;
  if not exists(select 1 from public.mobile_profiles where user_id=v_uid) then raise exception 'Choose a display name first.'; end if;
  perform pg_advisory_xact_lock(830261001);
  if (select count(*) from public.mobile_rooms where created_by=v_uid and closed_at is null and expires_at>now())>=3
    or (select count(*) from public.mobile_rooms where created_by=v_uid and created_at>now()-interval '1 day')>=10
    or (select count(*) from public.mobile_rooms where closed_at is null and expires_at>now())>=50
    or (select count(*) from public.mobile_rooms where created_at>now()-interval '1 day')>=200
    then raise exception 'Room capacity reached. Try again later.'; end if;
  insert into public.mobile_rooms(code_hash,label,created_by) values(p_code_hash,v_label,v_uid) returning id into v_id;
  insert into public.mobile_memberships(room_id,user_id) values(v_id,v_uid);
  return mobile_private.room_json(v_id);
end; $$;
create function mobile_private.join_room(p_code_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := mobile_private.require_user(); v_id uuid;
begin
  perform mobile_private.rate_limit(v_uid,'join',10,interval '1 minute');
  select id into v_id from public.mobile_rooms where code_hash=p_code_hash and closed_at is null and expires_at>now() for update;
  if v_id is null then raise exception 'This invitation is unavailable.'; end if;
  if not exists(select 1 from public.mobile_profiles where user_id=v_uid) then raise exception 'Choose a display name first.'; end if;
  if not exists(select 1 from public.mobile_memberships where room_id=v_id and user_id=v_uid) then
    if (select count(*) from public.mobile_memberships where room_id=v_id)>=100 then raise exception 'This room is full.'; end if;
    if (select count(*) from public.mobile_memberships m join public.mobile_rooms r on r.id=m.room_id
      where m.user_id=v_uid and r.closed_at is null and r.expires_at>now())>=20 then raise exception 'You have reached the joined room limit.'; end if;
    insert into public.mobile_memberships(room_id,user_id) values(v_id,v_uid);
  end if;
  return mobile_private.room_json(v_id);
end; $$;
create function mobile_private.rooms() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid:=mobile_private.require_user();
begin
  return coalesce((select jsonb_agg(mobile_private.room_json(m.room_id)||jsonb_build_object('watched',m.watched,'last_seen_at',m.last_seen_at) order by r.created_at desc)
    from public.mobile_memberships m join public.mobile_rooms r on r.id=m.room_id
    where m.user_id=v_uid and r.created_at>now()-interval '30 days'),'[]'::jsonb);
end; $$;
-- Returns a validated envelope ONLY. Edge mobile-send performs ephemeral REST Broadcast.
create function mobile_private.send_message(p_room_id uuid,p_message_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := mobile_private.require_member(p_room_id); v_sent timestamptz;
begin
  if p_message_id is null or p_payload is null or jsonb_typeof(p_payload)<>'object'
    or octet_length(p_payload::text)>14500 or (p_payload->>'v') is distinct from '1'
    or (p_payload->>'iv') is null or (p_payload->>'iv') !~ '^[A-Za-z0-9_-]{16}$'
    or (p_payload->>'data') is null or (p_payload->>'data') !~ '^[A-Za-z0-9_-]{22,14000}$'
    or (p_payload->>'sent_at') is null
    or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('v','iv','data','sent_at'))
    then raise exception 'Invalid encrypted message.'; end if;
  v_sent := (p_payload->>'sent_at')::timestamptz;
  if abs(extract(epoch from now()-v_sent))>300 then raise exception 'Check the time on your device.'; end if;
  perform mobile_private.rate_limit(v_uid,'send',5,interval '5 seconds');
  if exists(select 1 from mobile_private.message_receipts where message_id=p_message_id)
    then raise exception 'Message already submitted.'; end if;
  insert into mobile_private.message_receipts(message_id,user_id) values(p_message_id,v_uid);
  return (select jsonb_build_object('id',p_message_id,'room_id',p_room_id,'user_id',v_uid,
    'display_name',p.display_name,'is_creator',r.created_by=v_uid,'payload',p_payload,'created_at',now())
    from public.mobile_profiles p cross join public.mobile_rooms r where p.user_id=v_uid and r.id=p_room_id);
end; $$;
create function mobile_private.heartbeat(p_room_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := mobile_private.require_member(p_room_id); v_member public.mobile_memberships; v_event jsonb;
begin
  perform mobile_private.rate_limit(v_uid,'heartbeat',12,interval '1 minute');
  perform 1 from public.mobile_rooms where id=p_room_id for update;
  select * into v_member from public.mobile_memberships where room_id=p_room_id and user_id=v_uid for update;
  if (v_member.last_seen_at is null or v_member.last_seen_at<now()-interval '90 seconds' or v_member.left_at is not null)
    and (select count(*) from public.mobile_memberships where room_id=p_room_id and user_id<>v_uid and left_at is null and last_seen_at>now()-interval '90 seconds')>=20
    then raise exception 'This room has 20 people online. Try again shortly.'; end if;
  update public.mobile_memberships set last_seen_at=now(),left_at=null where room_id=p_room_id and user_id=v_uid;
  if (v_member.last_seen_at is null or v_member.last_seen_at<now()-interval '90 seconds' or v_member.left_at is not null)
    and (v_member.last_notified_at is null or v_member.last_notified_at<now()-interval '5 minutes') then
    update public.mobile_memberships set last_notified_at=now() where room_id=p_room_id and user_id=v_uid;
    v_event:=jsonb_build_object('user_id',v_uid,'display_name',(select display_name from public.mobile_profiles where user_id=v_uid),'online',true,'created_at',now());
    perform realtime.send(v_event,'presence','mobile-room:'||p_room_id,true);
    insert into mobile_private.push_queue(room_id,actor_id) values(p_room_id,v_uid);
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('user_id',m.user_id,'display_name',p.display_name,
    'last_seen_at',m.last_seen_at,'is_creator',r.created_by=m.user_id) order by m.joined_at)
    from public.mobile_memberships m join public.mobile_profiles p on p.user_id=m.user_id
    join public.mobile_rooms r on r.id=m.room_id
    where m.room_id=p_room_id and m.left_at is null and m.last_seen_at>now()-interval '90 seconds' and not p.disabled),'[]'::jsonb);
end; $$;
create function mobile_private.leave_room(p_room_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid:=mobile_private.require_user(); v_was_online boolean;
begin
  perform mobile_private.rate_limit(v_uid,'leave',20,interval '1 minute');
  select left_at is null and last_seen_at>now()-interval '90 seconds' into v_was_online
    from public.mobile_memberships where room_id=p_room_id and user_id=v_uid for update;
  update public.mobile_memberships set left_at=now() where room_id=p_room_id and user_id=v_uid;
  if v_was_online then perform realtime.send(jsonb_build_object('user_id',v_uid,'online',false,'created_at',now()),'presence','mobile-room:'||p_room_id,true); end if;
  return jsonb_build_object('left',true);
end; $$;
create function mobile_private.watch_room(p_room_id uuid,p_watched boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid:=mobile_private.require_user();
begin
  update public.mobile_memberships set watched=p_watched where room_id=p_room_id and user_id=v_uid;
  return jsonb_build_object('watched',p_watched);
end; $$;
create function mobile_private.request_deletion(p_room_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid:=mobile_private.require_member(p_room_id); v_id uuid; v_status text;
begin
  if not exists(select 1 from public.mobile_rooms where id=p_room_id and created_by=v_uid)
    then raise exception 'Only the room creator can request deletion.' using errcode='42501'; end if;
  insert into public.mobile_deletion_requests(room_id,requested_by) values(p_room_id,v_uid)
    on conflict(room_id) do nothing;
  select id,status into v_id,v_status from public.mobile_deletion_requests where room_id=p_room_id;
  return jsonb_build_object('id',v_id,'status',v_status);
end; $$;
create function mobile_private.notices() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform mobile_private.require_user();
  return coalesce((select jsonb_agg(to_jsonb(n) order by created_at desc) from
    (select id,title,body,created_at from public.mobile_notices where active order by created_at desc limit 20)n),'[]'::jsonb);
end; $$;
create function mobile_private.latest_release() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform mobile_private.require_user();
  return (select to_jsonb(r) from public.mobile_releases r order by version_code desc limit 1);
end; $$;
create function mobile_private.admin_overview() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform mobile_private.require_admin();
  return jsonb_build_object(
    'profiles',coalesce((select jsonb_agg(to_jsonb(p)) from public.mobile_profiles p),'[]'::jsonb),
    'rooms',coalesce((select jsonb_agg(mobile_private.room_json(r.id) order by r.created_at desc) from public.mobile_rooms r),'[]'::jsonb),
    'deletion_requests',coalesce((select jsonb_agg(to_jsonb(d)||jsonb_build_object('room_label',r.label,'display_name',p.display_name) order by d.created_at desc)
      from public.mobile_deletion_requests d join public.mobile_rooms r on r.id=d.room_id join public.mobile_profiles p on p.user_id=d.requested_by),'[]'::jsonb),
    'notices',coalesce((select jsonb_agg(to_jsonb(n) order by created_at desc) from public.mobile_notices n where active),'[]'::jsonb),
    'release',mobile_private.latest_release());
end; $$;
create function mobile_private.admin_close_room(p_room_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform mobile_private.require_admin();
  update public.mobile_rooms set closed_at=coalesce(closed_at,now()) where id=p_room_id;
  update public.mobile_memberships set left_at=now() where room_id=p_room_id;
  perform realtime.send(jsonb_build_object('room_id',p_room_id,'closed',true,'created_at',now()),'closed','mobile-room:'||p_room_id,true);
  return jsonb_build_object('closed',true);
end; $$;
create function mobile_private.admin_review_deletion(p_request_id uuid,p_approve boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_room uuid;
begin
  perform mobile_private.require_admin();
  update public.mobile_deletion_requests set status=case when p_approve then 'approved' else 'rejected' end,reviewed_at=now()
    where id=p_request_id and status='pending' returning room_id into v_room;
  if v_room is null then raise exception 'This request has already been reviewed.'; end if;
  if p_approve then perform mobile_private.admin_close_room(v_room); end if;
  return jsonb_build_object('approved',p_approve);
end; $$;
create function mobile_private.admin_set_disabled(p_user_id uuid,p_disabled boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid:=mobile_private.require_admin();
begin
  if p_user_id=v_uid then raise exception 'You cannot disable your own administrator account.'; end if;
  update public.mobile_profiles set disabled=p_disabled,updated_at=now() where user_id=p_user_id;
  if p_disabled then
    update public.mobile_memberships set left_at=now() where user_id=p_user_id;
    delete from mobile_private.devices where user_id=p_user_id;
  end if;
  return jsonb_build_object('disabled',p_disabled);
end; $$;
create function mobile_private.admin_publish_notice(p_title text,p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_notice public.mobile_notices;
begin
  perform mobile_private.require_admin();
  insert into public.mobile_notices(title,body) values(trim(p_title),trim(p_body)) returning * into v_notice;
  return to_jsonb(v_notice);
end; $$;
create function mobile_private.admin_remove_notice(p_notice_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform mobile_private.require_admin();
  update public.mobile_notices set active=false where id=p_notice_id;
  return jsonb_build_object('removed',true);
end; $$;
create function mobile_private.admin_publish_release(p_version_code integer,p_version text,p_apk_url text,p_sha256 text,p_notes text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_release public.mobile_releases;
begin
  perform mobile_private.require_admin();
  perform pg_advisory_xact_lock(830261002);
  if p_version_code <= coalesce((select max(version_code) from public.mobile_releases),0)
    then raise exception 'The new version code must be higher than the latest release.'; end if;
  insert into public.mobile_releases(version_code,version,apk_url,sha256,notes)
    values(p_version_code,p_version,p_apk_url,lower(p_sha256),coalesce(p_notes,'')) returning * into v_release;
  return to_jsonb(v_release);
end; $$;
create function mobile_private.can_receive(p_topic text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid;
begin
  v_uid:=mobile_private.require_user();
  return exists(select 1 from public.mobile_memberships m join public.mobile_rooms r on r.id=m.room_id
    where m.user_id=v_uid and p_topic='mobile-room:'||m.room_id and r.closed_at is null and r.expires_at>now());
exception when insufficient_privilege then return false;
end; $$;
-- No INSERT policy: clients cannot impersonate senders through direct Broadcast.
create policy mobile_member_receive on realtime.messages for select to authenticated
  using (extension='broadcast' and mobile_private.can_receive((select realtime.topic())));

-- Edge-only functions are granted exclusively to service_role. User-controlled
-- arguments never choose the identity: the Edge verifies JWT and passes auth user.id.
create function mobile_private.device(p_user_id uuid,p_token text,p_remove boolean,p_ip text,p_ip_source text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_ip inet;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Service access required.' using errcode='42501'; end if;
  if not exists(select 1 from public.mobile_profiles where user_id=p_user_id and not disabled) then raise exception 'Profile unavailable.'; end if;
  if p_ip is not null then
    begin v_ip:=p_ip::inet; exception when invalid_text_representation then v_ip:=null; end;
    if v_ip is not null then update public.mobile_profiles set last_ip=v_ip,ip_source=p_ip_source,updated_at=now() where user_id=p_user_id; end if;
  end if;
  if p_token is not null then
    if p_remove then delete from mobile_private.devices where token=p_token and user_id=p_user_id;
    else
      perform mobile_private.rate_limit(p_user_id,'device',10,interval '1 minute');
      if (select count(*) from mobile_private.devices where user_id=p_user_id)>=5 and not exists(select 1 from mobile_private.devices where token=p_token and user_id=p_user_id)
        then raise exception 'Device limit reached.'; end if;
      insert into mobile_private.devices(token,user_id) values(p_token,p_user_id)
        on conflict(token) do update set user_id=excluded.user_id,updated_at=now();
    end if;
  end if;
  return jsonb_build_object('registered',p_token is not null and not p_remove,'ip_recorded',v_ip is not null);
end; $$;
create function mobile_private.claim_push(p_actor_id uuid,p_room_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_event mobile_private.push_queue;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Service access required.' using errcode='42501'; end if;
  select * into v_event from mobile_private.push_queue where actor_id=p_actor_id and room_id=p_room_id
    and completed_at is null and (claimed_at is null or claimed_at<now()-interval '2 minutes')
    and created_at>now()-interval '5 minutes' order by created_at limit 1 for update skip locked;
  if v_event.id is null then return null; end if;
  update mobile_private.push_queue set claimed_at=now() where id=v_event.id;
  return jsonb_build_object('id',v_event.id,'room_id',p_room_id,'tokens',coalesce((select jsonb_agg(d.token)
    from mobile_private.devices d join public.mobile_memberships m on m.user_id=d.user_id
    join public.mobile_profiles p on p.user_id=d.user_id join public.mobile_rooms r on r.id=m.room_id
    where m.room_id=p_room_id and m.user_id<>p_actor_id and m.watched and not p.disabled
      and r.closed_at is null and r.expires_at>now() and d.updated_at>now()-interval '60 days'),'[]'::jsonb));
end; $$;
create function mobile_private.finish_push(p_event_id uuid,p_invalid_tokens text[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Service access required.' using errcode='42501'; end if;
  update mobile_private.push_queue set completed_at=now() where id=p_event_id;
  delete from mobile_private.devices where token=any(p_invalid_tokens);
end; $$;

-- Public invoker wrappers expose only the intended RPC surface. Privileged bodies
-- live outside the exposed schema and each begins with its authorization check.
create function public.mobile_profile(p_display_name text default null) returns jsonb language sql security invoker set search_path='' as $$select mobile_private.profile(p_display_name)$$;
create function public.mobile_create_room(p_code_hash text,p_label text) returns jsonb language sql security invoker set search_path='' as $$select mobile_private.create_room(p_code_hash,p_label)$$;
create function public.mobile_join_room(p_code_hash text) returns jsonb language sql security invoker set search_path='' as $$select mobile_private.join_room(p_code_hash)$$;
create function public.mobile_rooms() returns jsonb language sql security invoker set search_path='' as $$select mobile_private.rooms()$$;
create function public.mobile_send_message(p_room_id uuid,p_message_id uuid,p_payload jsonb) returns jsonb language sql security invoker set search_path='' as $$select mobile_private.send_message(p_room_id,p_message_id,p_payload)$$;
create function public.mobile_heartbeat(p_room_id uuid) returns jsonb language sql security invoker set search_path='' as $$select mobile_private.heartbeat(p_room_id)$$;
create function public.mobile_leave_room(p_room_id uuid) returns jsonb language sql security invoker set search_path='' as $$select mobile_private.leave_room(p_room_id)$$;
create function public.mobile_watch_room(p_room_id uuid,p_watched boolean) returns jsonb language sql security invoker set search_path='' as $$select mobile_private.watch_room(p_room_id,p_watched)$$;
create function public.mobile_request_deletion(p_room_id uuid) returns jsonb language sql security invoker set search_path='' as $$select mobile_private.request_deletion(p_room_id)$$;
create function public.mobile_notices() returns jsonb language sql security invoker set search_path='' as $$select mobile_private.notices()$$;
create function public.mobile_latest_release() returns jsonb language sql security invoker set search_path='' as $$select mobile_private.latest_release()$$;
create function public.mobile_admin_overview() returns jsonb language sql security invoker set search_path='' as $$select mobile_private.admin_overview()$$;
create function public.mobile_admin_close_room(p_room_id uuid) returns jsonb language sql security invoker set search_path='' as $$select mobile_private.admin_close_room(p_room_id)$$;
create function public.mobile_admin_review_deletion(p_request_id uuid,p_approve boolean) returns jsonb language sql security invoker set search_path='' as $$select mobile_private.admin_review_deletion(p_request_id,p_approve)$$;
create function public.mobile_admin_set_disabled(p_user_id uuid,p_disabled boolean) returns jsonb language sql security invoker set search_path='' as $$select mobile_private.admin_set_disabled(p_user_id,p_disabled)$$;
create function public.mobile_admin_publish_notice(p_title text,p_body text) returns jsonb language sql security invoker set search_path='' as $$select mobile_private.admin_publish_notice(p_title,p_body)$$;
create function public.mobile_admin_remove_notice(p_notice_id uuid) returns jsonb language sql security invoker set search_path='' as $$select mobile_private.admin_remove_notice(p_notice_id)$$;
create function public.mobile_admin_publish_release(p_version_code integer,p_version text,p_apk_url text,p_sha256 text,p_notes text) returns jsonb language sql security invoker set search_path='' as $$select mobile_private.admin_publish_release(p_version_code,p_version,p_apk_url,p_sha256,p_notes)$$;
create function public.mobile_edge_device(p_user_id uuid,p_token text,p_remove boolean,p_ip text,p_ip_source text) returns jsonb language sql security invoker set search_path='' as $$select mobile_private.device(p_user_id,p_token,p_remove,p_ip,p_ip_source)$$;
create function public.mobile_edge_claim_push(p_actor_id uuid,p_room_id uuid) returns jsonb language sql security invoker set search_path='' as $$select mobile_private.claim_push(p_actor_id,p_room_id)$$;
create function public.mobile_edge_finish_push(p_event_id uuid,p_invalid_tokens text[]) returns void language sql security invoker set search_path='' as $$select mobile_private.finish_push(p_event_id,p_invalid_tokens)$$;

revoke all on all functions in schema mobile_private from public,anon,authenticated;
-- Grant just entrypoints; helpers taking arbitrary IDs remain inaccessible.
grant execute on function mobile_private.profile(text),mobile_private.create_room(text,text),mobile_private.join_room(text),mobile_private.rooms(),
  mobile_private.send_message(uuid,uuid,jsonb),mobile_private.heartbeat(uuid),mobile_private.leave_room(uuid),mobile_private.watch_room(uuid,boolean),
  mobile_private.request_deletion(uuid),mobile_private.notices(),mobile_private.latest_release(),mobile_private.admin_overview(),
  mobile_private.admin_close_room(uuid),mobile_private.admin_review_deletion(uuid,boolean),mobile_private.admin_set_disabled(uuid,boolean),
  mobile_private.admin_publish_notice(text,text),mobile_private.admin_remove_notice(uuid),mobile_private.admin_publish_release(integer,text,text,text,text),
  mobile_private.can_receive(text) to authenticated;
grant execute on function mobile_private.device(uuid,text,boolean,text,text),mobile_private.claim_push(uuid,uuid),mobile_private.finish_push(uuid,text[]) to service_role;
do $$declare f record; begin
  for f in select p.oid::regprocedure sig,p.proname from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'mobile\_%' escape '\' loop
    execute format('revoke all on function %s from public, anon, authenticated',f.sig);
    execute format('grant execute on function %s to %I',f.sig,case when f.proname like 'mobile_edge_%' then 'service_role' else 'authenticated' end);
  end loop;
end $$;

-- Prune only mobile delivery metadata. This never touches website data.
select cron.schedule('mobile-metadata-prune','17 * * * *',$prune$
  delete from mobile_private.message_receipts where created_at<now()-interval '10 minutes';
  delete from mobile_private.rate_limits where updated_at<now()-interval '1 day';
  delete from mobile_private.push_queue where created_at<now()-interval '1 day';
  delete from mobile_private.devices where updated_at<now()-interval '60 days';
$prune$);

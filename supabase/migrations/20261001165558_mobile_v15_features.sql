-- v1.5: verified email sign-in, bounded timed rooms, permanent admin groups,
-- creator extension requests, and administrator review. Existing rooms survive.
create or replace function mobile_private.require_user() returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_provider text := auth.jwt()->'app_metadata'->>'provider';
begin
  if v_uid is null or v_provider not in ('google','email') or not exists (
    select 1 from auth.users u join auth.identities i on i.user_id=u.id
    where u.id=v_uid and u.email_confirmed_at is not null and u.deleted_at is null
      and not coalesce(u.is_anonymous,false) and (u.banned_until is null or u.banned_until<now())
      and lower(i.email)=lower(u.email) and i.provider=v_provider
      and (i.provider='email' or i.identity_data->>'email_verified'='true')
  ) or not exists (
    select 1 from auth.sessions s where s.user_id=v_uid
      and s.id::text=auth.jwt()->>'session_id' and (s.not_after is null or s.not_after>now())
  ) then raise exception 'Sign in with a verified Google or email account.' using errcode='42501'; end if;
  if exists(select 1 from public.mobile_profiles p where p.user_id=v_uid and p.disabled)
    then raise exception 'This account is disabled.' using errcode='42501'; end if;
  return v_uid;
end; $$;
create or replace function mobile_private.is_admin() returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := mobile_private.require_user();
begin
  return exists(select 1 from auth.users u where u.id=v_uid
    and lower(u.email)='viratanand1221@gmail.com' and u.email_confirmed_at is not null);
end; $$;

create function mobile_private.create_room_v15(p_code_hash text,p_label text,p_duration_hours integer default 24,p_permanent boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid:=mobile_private.require_user(); v_admin boolean:=mobile_private.is_admin(); v_id uuid; v_label text:=trim(p_label);
begin
  if p_code_hash is null or p_code_hash !~ '^[a-f0-9]{64}$' or v_label is null or length(v_label) not between 1 and 60 or v_label ~ '[[:cntrl:]]'
    then raise exception 'A valid invitation and room name are required.'; end if;
  if p_duration_hours is null or p_duration_hours not between 1 and 24 or p_permanent is null
    then raise exception 'Choose a room duration from 1 to 24 hours.'; end if;
  if p_permanent and not v_admin then raise exception 'Only the administrator can create a permanent group.' using errcode='42501'; end if;
  if not exists(select 1 from public.mobile_profiles where user_id=v_uid) then raise exception 'Choose a display name first.'; end if;
  perform pg_advisory_xact_lock(830261001);
  if (select count(*) from public.mobile_rooms where created_by=v_uid and closed_at is null and expires_at>now()) >= (case when v_admin then 20 else 3 end)
    or (select count(*) from public.mobile_rooms where created_by=v_uid and created_at>now()-interval '1 day') >= (case when v_admin then 20 else 10 end)
    or (select count(*) from public.mobile_rooms where closed_at is null and expires_at>now())>=50
    or (select count(*) from public.mobile_rooms where created_at>now()-interval '1 day')>=200
    then raise exception 'Room capacity reached. Try again later.'; end if;
  -- Infinity uses the existing expiry checks, indexes and cleanup safely.
  insert into public.mobile_rooms(code_hash,label,created_by,expires_at)
    values(p_code_hash,v_label,v_uid,case when p_permanent then 'infinity'::timestamptz else now()+make_interval(hours=>p_duration_hours) end) returning id into v_id;
  insert into public.mobile_memberships(room_id,user_id) values(v_id,v_uid);
  return mobile_private.room_json(v_id);
end; $$;
create or replace function mobile_private.create_room(p_code_hash text,p_label text) returns jsonb
language sql security definer set search_path='' as $$ select mobile_private.create_room_v15(p_code_hash,p_label,24,false) $$;

create table public.mobile_extension_requests (
  id uuid primary key default gen_random_uuid(), room_id uuid not null references public.mobile_rooms(id) on delete cascade,
  requested_by uuid not null references public.mobile_profiles(user_id), hours integer not null check(hours between 1 and 24),
  status text not null default 'pending' check(status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(), reviewed_at timestamptz, reviewed_by uuid references public.mobile_profiles(user_id)
);
create unique index mobile_extension_one_pending on public.mobile_extension_requests(room_id) where status='pending';
create index mobile_extension_room_idx on public.mobile_extension_requests(room_id);
create index mobile_extension_requester_idx on public.mobile_extension_requests(requested_by);
create index mobile_extension_reviewer_idx on public.mobile_extension_requests(reviewed_by);
alter table public.mobile_extension_requests enable row level security;
revoke all on public.mobile_extension_requests from public,anon,authenticated;

create function mobile_private.request_extension(p_room_id uuid,p_hours integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=mobile_private.require_member(p_room_id); v_request public.mobile_extension_requests;
begin
  if p_hours is null or p_hours not between 1 and 24 then raise exception 'Request from 1 to 24 extra hours.'; end if;
  perform 1 from public.mobile_rooms where id=p_room_id and created_by=v_uid and expires_at<>'infinity'::timestamptz for update;
  if not found then raise exception 'Only the creator of a timed room can request an extension.' using errcode='42501'; end if;
  perform mobile_private.rate_limit(v_uid,'extend-request',5,interval '1 day');
  insert into public.mobile_extension_requests(room_id,requested_by,hours) values(p_room_id,v_uid,p_hours)
    on conflict(room_id) where status='pending' do nothing;
  select * into v_request from public.mobile_extension_requests where room_id=p_room_id and status='pending';
  return to_jsonb(v_request);
end; $$;
create function mobile_private.admin_extend_room(p_room_id uuid,p_hours integer) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform mobile_private.require_admin();
  if p_hours is null or p_hours not between 1 and 8760 then raise exception 'Choose from 1 to 8760 extra hours.'; end if;
  perform pg_advisory_xact_lock(830261001);
  perform 1 from public.mobile_rooms where id=p_room_id and closed_at is null and expires_at<>'infinity'::timestamptz for update;
  if not found then raise exception 'This timed room is unavailable or already permanent.'; end if;
  if (select expires_at<=now() from public.mobile_rooms where id=p_room_id)
    and (select count(*) from public.mobile_rooms where closed_at is null and expires_at>now())>=50
    then raise exception 'Room capacity reached. Try again later.'; end if;
  update public.mobile_rooms set expires_at=greatest(expires_at,now())+make_interval(hours=>p_hours) where id=p_room_id;
  return mobile_private.room_json(p_room_id);
end; $$;
create function mobile_private.admin_review_extension(p_request_id uuid,p_approve boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=mobile_private.require_admin(); v_request public.mobile_extension_requests;
begin
  if p_approve is null then raise exception 'Choose approve or decline.'; end if;
  -- Acquire the capacity lock before the request lock to avoid inverted locks.
  perform pg_advisory_xact_lock(830261001);
  select * into v_request from public.mobile_extension_requests where id=p_request_id and status='pending' for update;
  if not found then raise exception 'This request has already been reviewed.'; end if;
  if p_approve then perform mobile_private.admin_extend_room(v_request.room_id,v_request.hours); end if;
  update public.mobile_extension_requests set status=case when p_approve then 'approved' else 'rejected' end,
    reviewed_at=now(),reviewed_by=v_uid where id=p_request_id;
  return jsonb_build_object('approved',p_approve);
end; $$;

create or replace function mobile_private.admin_overview() returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform mobile_private.require_admin();
  return jsonb_build_object(
    'profiles',coalesce((select jsonb_agg(to_jsonb(p) order by updated_at desc) from (select * from public.mobile_profiles order by updated_at desc limit 300)p),'[]'::jsonb),
    'rooms',coalesce((select jsonb_agg(mobile_private.room_json(r.id) order by r.created_at desc) from (select id,created_at from public.mobile_rooms order by created_at desc limit 100)r),'[]'::jsonb),
    'deletion_requests',coalesce((select jsonb_agg(to_jsonb(d)||jsonb_build_object('room_label',r.label,'display_name',p.display_name) order by d.created_at desc)
      from (select * from public.mobile_deletion_requests order by (status='pending') desc,created_at desc limit 100)d
      join public.mobile_rooms r on r.id=d.room_id join public.mobile_profiles p on p.user_id=d.requested_by),'[]'::jsonb),
    'extension_requests',coalesce((select jsonb_agg(to_jsonb(d)||jsonb_build_object('room_label',r.label,'display_name',p.display_name) order by d.created_at desc)
      from (select * from public.mobile_extension_requests order by (status='pending') desc,created_at desc limit 100)d
      join public.mobile_rooms r on r.id=d.room_id join public.mobile_profiles p on p.user_id=d.requested_by),'[]'::jsonb),
    'notices',coalesce((select jsonb_agg(to_jsonb(n) order by created_at desc) from (select * from public.mobile_notices where active order by created_at desc limit 20)n),'[]'::jsonb),
    'release',mobile_private.latest_release());
end; $$;

create function public.mobile_create_room_v15(p_code_hash text,p_label text,p_duration_hours integer default 24,p_permanent boolean default false) returns jsonb language sql security invoker set search_path='' as $$select mobile_private.create_room_v15(p_code_hash,p_label,p_duration_hours,p_permanent)$$;
create function public.mobile_request_extension(p_room_id uuid,p_hours integer) returns jsonb language sql security invoker set search_path='' as $$select mobile_private.request_extension(p_room_id,p_hours)$$;
create function public.mobile_admin_extend_room(p_room_id uuid,p_hours integer) returns jsonb language sql security invoker set search_path='' as $$select mobile_private.admin_extend_room(p_room_id,p_hours)$$;
create function public.mobile_admin_review_extension(p_request_id uuid,p_approve boolean) returns jsonb language sql security invoker set search_path='' as $$select mobile_private.admin_review_extension(p_request_id,p_approve)$$;
revoke all on function mobile_private.create_room_v15(text,text,integer,boolean),mobile_private.request_extension(uuid,integer),mobile_private.admin_extend_room(uuid,integer),mobile_private.admin_review_extension(uuid,boolean),public.mobile_create_room_v15(text,text,integer,boolean),public.mobile_request_extension(uuid,integer),public.mobile_admin_extend_room(uuid,integer),public.mobile_admin_review_extension(uuid,boolean) from public,anon,authenticated;
grant execute on function mobile_private.create_room_v15(text,text,integer,boolean),mobile_private.request_extension(uuid,integer),mobile_private.admin_extend_room(uuid,integer),mobile_private.admin_review_extension(uuid,boolean),public.mobile_create_room_v15(text,text,integer,boolean),public.mobile_request_extension(uuid,integer),public.mobile_admin_extend_room(uuid,integer),public.mobile_admin_review_extension(uuid,boolean) to authenticated;

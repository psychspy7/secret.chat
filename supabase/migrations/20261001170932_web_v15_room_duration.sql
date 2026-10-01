-- Preserve the established website invitation and administrator key model.
create function app_private.create_room_v15(p_code_hash text,p_key_hash text,p_label_cipher jsonb,p_host_key_cipher jsonb,p_duration_hours integer default 24)
returns setof public.rooms language plpgsql security definer set search_path='' as $$
declare v_room public.rooms;
begin
  if p_duration_hours is null or p_duration_hours not between 1 and 24 then raise exception 'Choose a duration from 1 to 24 hours.'; end if;
  select * into v_room from public.create_room(p_code_hash,p_key_hash,p_label_cipher,p_host_key_cipher);
  if v_room.is_public_created then
    update public.rooms set expires_at=now()+make_interval(hours=>p_duration_hours) where id=v_room.id returning * into v_room;
  end if;
  return next v_room;
end; $$;
create function public.create_room_v15(p_code_hash text,p_key_hash text,p_label_cipher jsonb,p_host_key_cipher jsonb,p_duration_hours integer default 24)
returns setof public.rooms language sql security invoker set search_path='' as $$select * from app_private.create_room_v15(p_code_hash,p_key_hash,p_label_cipher,p_host_key_cipher,p_duration_hours)$$;

create table public.room_extension_requests (
  id uuid primary key default gen_random_uuid(), room_id uuid not null references public.rooms(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete cascade, hours integer not null check(hours between 1 and 24),
  status text not null default 'pending' check(status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(), reviewed_at timestamptz, reviewed_by uuid references auth.users(id) on delete set null
);
create unique index room_extension_one_pending on public.room_extension_requests(room_id) where status='pending';
create index room_extension_room_idx on public.room_extension_requests(room_id);
create index room_extension_requester_idx on public.room_extension_requests(requested_by);
create index room_extension_reviewer_idx on public.room_extension_requests(reviewed_by);
alter table public.room_extension_requests enable row level security;
revoke all on public.room_extension_requests from public,anon,authenticated;

create function app_private.request_extension(p_room_id uuid,p_hours integer) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  if auth.uid() is null or p_hours is null or p_hours not between 1 and 24 then raise exception 'Choose from 1 to 24 extra hours.'; end if;
  perform 1 from public.rooms where id=p_room_id and host_user_id=auth.uid() and is_public_created and is_active and expires_at>now() for update;
  if not found then raise exception 'Only the creator of an active timed room can request more time.' using errcode='42501'; end if;
  if (select count(*) from public.room_extension_requests where requested_by=auth.uid() and created_at>now()-interval '1 day')>=5 then raise exception 'Please wait before requesting another extension.'; end if;
  insert into public.room_extension_requests(room_id,requested_by,hours) values(p_room_id,auth.uid(),p_hours) on conflict(room_id) where status='pending' do nothing;
  select id into v_id from public.room_extension_requests where room_id=p_room_id and status='pending';
  return v_id;
end; $$;
create function app_private.list_extensions() returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  if not app_private.is_admin() then raise exception 'Administrator access required.' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(r)) from (select id,room_id,hours,created_at from public.room_extension_requests where status='pending' order by created_at limit 100)r),'[]'::jsonb);
end; $$;
create function app_private.extend_room(p_room_id uuid,p_hours integer) returns void
language plpgsql security definer set search_path='' as $$
begin
  if not app_private.is_admin() then raise exception 'Administrator access required.' using errcode='42501'; end if;
  if p_hours is null or p_hours not between 1 and 8760 then raise exception 'Choose from 1 to 8760 extra hours.'; end if;
  perform pg_advisory_xact_lock(73190223);
  perform 1 from public.rooms where id=p_room_id and is_active and expires_at is not null for update;
  if not found then raise exception 'This room is closed or has no expiry.'; end if;
  update public.rooms set expires_at=greatest(expires_at,now())+make_interval(hours=>p_hours) where id=p_room_id;
end; $$;
create function app_private.review_extension(p_request_id uuid,p_approve boolean) returns void
language plpgsql security definer set search_path='' as $$
declare v_request public.room_extension_requests;
begin
  if not app_private.is_admin() then raise exception 'Administrator access required.' using errcode='42501'; end if;
  if p_approve is null then raise exception 'Choose approve or decline.'; end if;
  perform pg_advisory_xact_lock(73190223);
  select * into v_request from public.room_extension_requests where id=p_request_id and status='pending' for update;
  if not found then raise exception 'This request has already been reviewed.'; end if;
  if p_approve then perform app_private.extend_room(v_request.room_id,v_request.hours); end if;
  update public.room_extension_requests set status=case when p_approve then 'approved' else 'rejected' end,reviewed_at=now(),reviewed_by=auth.uid() where id=p_request_id;
end; $$;
create function public.request_room_extension(p_room_id uuid,p_hours integer) returns uuid language sql security invoker set search_path='' as $$select app_private.request_extension(p_room_id,p_hours)$$;
create function public.list_room_extension_requests() returns jsonb language sql security invoker set search_path='' as $$select app_private.list_extensions()$$;
create function public.extend_room_time(p_room_id uuid,p_hours integer) returns void language sql security invoker set search_path='' as $$select app_private.extend_room(p_room_id,p_hours)$$;
create function public.review_room_extension(p_request_id uuid,p_approve boolean) returns void language sql security invoker set search_path='' as $$select app_private.review_extension(p_request_id,p_approve)$$;
revoke all on function app_private.create_room_v15(text,text,jsonb,jsonb,integer),app_private.request_extension(uuid,integer),app_private.list_extensions(),app_private.extend_room(uuid,integer),app_private.review_extension(uuid,boolean),public.create_room_v15(text,text,jsonb,jsonb,integer),public.request_room_extension(uuid,integer),public.list_room_extension_requests(),public.extend_room_time(uuid,integer),public.review_room_extension(uuid,boolean) from public,anon,authenticated;
grant execute on function app_private.create_room_v15(text,text,jsonb,jsonb,integer),app_private.request_extension(uuid,integer),app_private.list_extensions(),app_private.extend_room(uuid,integer),app_private.review_extension(uuid,boolean),public.create_room_v15(text,text,jsonb,jsonb,integer),public.request_room_extension(uuid,integer),public.list_room_extension_requests(),public.extend_room_time(uuid,integer),public.review_room_extension(uuid,boolean) to authenticated;

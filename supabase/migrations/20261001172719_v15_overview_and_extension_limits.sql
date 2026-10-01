-- Keep aggregate counts in the bounded administrator overview.
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
    'counts',jsonb_build_object('profiles',(select count(*) from public.mobile_profiles),'rooms',(select count(*) from public.mobile_rooms),
      'pending_requests',(select count(*) from public.mobile_deletion_requests where status='pending'),
      'pending_extensions',(select count(*) from public.mobile_extension_requests where status='pending')),
    'release',mobile_private.latest_release());
end; $$;


-- Serialize per-account request limits consistently with room creation/review.
create or replace function app_private.request_extension(p_room_id uuid,p_hours integer) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  if auth.uid() is null or p_hours is null or p_hours not between 1 and 24 then raise exception 'Choose from 1 to 24 extra hours.'; end if;
  perform pg_advisory_xact_lock(73190223);
  perform 1 from public.rooms where id=p_room_id and host_user_id=auth.uid() and is_public_created and is_active and expires_at>now() for update;
  if not found then raise exception 'Only the creator of an active timed room can request more time.' using errcode='42501'; end if;
  if (select count(*) from public.room_extension_requests where requested_by=auth.uid() and created_at>now()-interval '1 day')>=5 then raise exception 'Please wait before requesting another extension.'; end if;
  insert into public.room_extension_requests(room_id,requested_by,hours) values(p_room_id,auth.uid(),p_hours) on conflict(room_id) where status='pending' do nothing;
  select id into v_id from public.room_extension_requests where room_id=p_room_id and status='pending';
  return v_id;
end; $$;

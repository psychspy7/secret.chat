-- Keep administrator overview bounded on low-memory phones. Counts disclose when
-- only the newest page is displayed instead of pretending it contains all rows.
create or replace function mobile_private.admin_overview() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform mobile_private.require_admin();
  return jsonb_build_object(
    'profiles',coalesce((select jsonb_agg(to_jsonb(p) order by updated_at desc) from
      (select * from public.mobile_profiles order by updated_at desc limit 500)p),'[]'::jsonb),
    'rooms',coalesce((select jsonb_agg(mobile_private.room_json(r.id) order by r.created_at desc) from
      (select id,created_at from public.mobile_rooms order by created_at desc limit 200)r),'[]'::jsonb),
    'deletion_requests',coalesce((select jsonb_agg(to_jsonb(d)||jsonb_build_object('room_label',r.label,'display_name',p.display_name) order by d.created_at desc)
      from (select * from public.mobile_deletion_requests order by (status='pending') desc,created_at desc limit 200)d
      join public.mobile_rooms r on r.id=d.room_id join public.mobile_profiles p on p.user_id=d.requested_by),'[]'::jsonb),
    'notices',coalesce((select jsonb_agg(to_jsonb(n) order by created_at desc) from
      (select * from public.mobile_notices where active order by created_at desc limit 20)n),'[]'::jsonb),
    'counts',jsonb_build_object('profiles',(select count(*) from public.mobile_profiles),'rooms',(select count(*) from public.mobile_rooms),
      'pending_requests',(select count(*) from public.mobile_deletion_requests where status='pending')),
    'release',mobile_private.latest_release());
end; $$;

create or replace function mobile_private.claim_push(p_actor_id uuid,p_room_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_event mobile_private.push_queue;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Service access required.' using errcode='42501'; end if;
  select * into v_event from mobile_private.push_queue where actor_id=p_actor_id and room_id=p_room_id
    and completed_at is null and (claimed_at is null or claimed_at<now()-interval '2 minutes')
    and created_at>now()-interval '5 minutes' order by created_at limit 1 for update skip locked;
  if v_event.id is null then return null; end if;
  update mobile_private.push_queue set claimed_at=now() where id=v_event.id;
  return jsonb_build_object('id',v_event.id,'room_id',p_room_id,'devices',coalesce((select jsonb_agg(jsonb_build_object('token',d.token,'user_id',d.user_id))
    from mobile_private.devices d join public.mobile_memberships m on m.user_id=d.user_id
    join public.mobile_profiles p on p.user_id=d.user_id join public.mobile_rooms r on r.id=m.room_id
    where m.room_id=p_room_id and m.user_id<>p_actor_id and m.watched and not p.disabled
      and r.closed_at is null and r.expires_at>now() and d.updated_at>now()-interval '60 days'),'[]'::jsonb));
end; $$;

create or replace function mobile_private.heartbeat(p_room_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := mobile_private.require_member(p_room_id); v_member public.mobile_memberships; v_event jsonb; v_transition boolean; v_absent boolean;
begin
  perform mobile_private.rate_limit(v_uid,'heartbeat',12,interval '1 minute');
  perform 1 from public.mobile_rooms where id=p_room_id for update;
  select * into v_member from public.mobile_memberships where room_id=p_room_id and user_id=v_uid for update;
  v_transition:=v_member.last_seen_at is null or v_member.last_seen_at<now()-interval '90 seconds' or v_member.left_at is not null;
  v_absent:=v_member.last_seen_at is null or v_member.last_seen_at<now()-interval '90 seconds';
  if v_transition and (select count(*) from public.mobile_memberships where room_id=p_room_id and user_id<>v_uid and left_at is null and last_seen_at>now()-interval '90 seconds')>=20
    then raise exception 'This room has 20 people online. Try again shortly.'; end if;
  update public.mobile_memberships set last_seen_at=now(),left_at=null where room_id=p_room_id and user_id=v_uid;
  if v_transition then
    v_event:=jsonb_build_object('user_id',v_uid,'display_name',(select display_name from public.mobile_profiles where user_id=v_uid),'online',true,
      'notify',v_absent and (v_member.last_notified_at is null or v_member.last_notified_at<now()-interval '5 minutes'),'created_at',now());
    perform realtime.send(v_event,'presence','mobile-room:'||p_room_id,true);
    if (v_event->>'notify')::boolean then
      update public.mobile_memberships set last_notified_at=now() where room_id=p_room_id and user_id=v_uid;
      insert into mobile_private.push_queue(room_id,actor_id) values(p_room_id,v_uid);
    end if;
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('user_id',m.user_id,'display_name',p.display_name,
    'last_seen_at',m.last_seen_at,'is_creator',r.created_by=m.user_id) order by m.joined_at)
    from public.mobile_memberships m join public.mobile_profiles p on p.user_id=m.user_id
    join public.mobile_rooms r on r.id=m.room_id
    where m.room_id=p_room_id and m.left_at is null and m.last_seen_at>now()-interval '90 seconds' and not p.disabled),'[]'::jsonb);
end; $$;

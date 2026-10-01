-- PostgreSQL POSIX regex repetition bounds cannot exceed 255. Check encrypted
-- payload length separately, then validate its alphabet without a large bound.
create or replace function mobile_private.send_message(p_room_id uuid,p_message_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := mobile_private.require_member(p_room_id); v_sent timestamptz;
begin
  if p_message_id is null or p_payload is null or jsonb_typeof(p_payload)<>'object'
    or octet_length(p_payload::text)>14500 or (p_payload->>'v') is distinct from '1'
    or (p_payload->>'iv') is null or (p_payload->>'iv') !~ '^[A-Za-z0-9_-]{16}$'
    or (p_payload->>'data') is null or length(p_payload->>'data') not between 22 and 14000
    or (p_payload->>'data') !~ '^[A-Za-z0-9_-]+$'
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

-- Run as the database owner. All fixtures, identities, sessions and messages are
-- rolled back, even when an assertion fails. No existing account is modified.
begin;
create temporary table mobile_test_results(check_name text) on commit drop;
grant select,insert on mobile_test_results to authenticated;
do $$
declare
  a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); adm uuid:=gen_random_uuid();
  sa uuid:=gen_random_uuid(); sb uuid:=gen_random_uuid(); sc uuid:=gen_random_uuid(); sd uuid:=gen_random_uuid();
  room uuid; request_id uuid; receipt uuid:=gen_random_uuid();
  hash text:=encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex');
  payload jsonb:=jsonb_build_object('v',1,'iv','AAAAAAAAAAAAAAAA','data','AAAAAAAAAAAAAAAAAAAAAA','sent_at',now());
  result jsonb; e record; n integer; admin_email text:='VIRATANAND1221@GMAIL.COM';
begin
  -- Case-variant synthetic identity also verifies case-insensitive admin matching.
  -- Never change an existing account, including the real lowercase admin login.
  if exists(select 1 from auth.users where email=admin_email) then
    raise exception 'This exact fixture address exists; run on a disposable branch.';
  end if;
  insert into auth.users(id,role,aud,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    values(a,'authenticated','authenticated','mobile-test-a-'||a||'@example.invalid',now(),'{"provider":"google","providers":["google"]}','{}',now(),now()),
      (b,'authenticated','authenticated','mobile-test-b-'||b||'@example.invalid',now(),'{"provider":"google","providers":["google"]}','{}',now(),now()),
      (c,'authenticated','authenticated','mobile-test-c-'||c||'@example.invalid',now(),'{"provider":"email","providers":["email"]}',jsonb_build_object('email',admin_email,'provider','google','is_admin',true),now(),now()),
      (adm,'authenticated','authenticated',admin_email,now(),'{"provider":"google","providers":["google"]}','{}',now(),now());
  insert into auth.identities(user_id,provider_id,provider,identity_data,created_at,updated_at)
    select id,id::text,'google',jsonb_build_object('sub',id::text,'email',email,'email_verified',true),now(),now()
      from auth.users where id in(a,b,adm);
  insert into auth.sessions(id,user_id,created_at,updated_at) values(sa,a,now(),now()),(sb,b,now(),now()),(sc,c,now(),now()),(sd,adm,now(),now());

  for e in select p.oid,p.proname from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'mobile\_%' escape '\' loop
    if has_function_privilege('anon',e.oid,'execute') then raise exception 'Anonymous can call %',e.proname; end if;
    if e.proname like 'mobile_edge_%' and has_function_privilege('authenticated',e.oid,'execute') then raise exception 'User can call service endpoint %',e.proname; end if;
  end loop;
  if exists(select 1 from pg_class t join pg_namespace ns on ns.oid=t.relnamespace where
      (ns.nspname='mobile_private' or (ns.nspname='public' and t.relname like 'mobile\_%' escape '\'))
      and t.relkind='r' and (not t.relrowsecurity or has_table_privilege('authenticated',t.oid,'select,insert,update,delete')))
    then raise exception 'Mobile table lacks RLS or exposes direct user access.'; end if;
  insert into mobile_test_results values('anonymous/service grants and table RLS');

  perform set_config('request.jwt.claims',jsonb_build_object('sub',c,'role','authenticated','session_id',sc,'app_metadata',jsonb_build_object('provider','google'),'user_metadata',jsonb_build_object('email',admin_email,'is_admin',true))::text,true);
  begin perform public.mobile_profile('Spoof'); raise exception 'Spoof accepted'; exception when insufficient_privilege then null; end;
  insert into mobile_test_results values('user_metadata email/admin/provider spoof rejected');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',a,'role','authenticated','session_id',gen_random_uuid(),'app_metadata',jsonb_build_object('provider','google'))::text,true);
  begin perform public.mobile_profile('Alice'); raise exception 'Missing session accepted'; exception when insufficient_privilege then null; end;
  insert into mobile_test_results values('revoked/unknown session rejected');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',a,'role','authenticated','session_id',sa,'app_metadata',jsonb_build_object('provider','email'))::text,true);
  begin perform public.mobile_profile('Alice'); raise exception 'Non-Google login accepted'; exception when insufficient_privilege then null; end;
  insert into mobile_test_results values('non-Google token rejected');

  perform set_config('request.jwt.claims',jsonb_build_object('sub',a,'role','authenticated','session_id',sa,'app_metadata',jsonb_build_object('provider','google'))::text,true);
  result:=public.mobile_profile('Alice');
  if result->>'display_name'<>'Alice' or (result->>'is_admin')::boolean then raise exception 'Ordinary profile incorrect'; end if;
  room:=(public.mobile_create_room(hash,'Fixture room')->>'id')::uuid;
  if jsonb_array_length(public.mobile_rooms())<>1 then raise exception 'Joined room list incorrect'; end if;
  if jsonb_array_length(public.mobile_heartbeat(room))<>1 then raise exception 'Heartbeat incorrect'; end if;
  perform public.mobile_heartbeat(room);
  if (select count(*) from mobile_private.push_queue where room_id=room)<>1 then raise exception 'Duplicate heartbeat pushed'; end if;
  perform public.mobile_leave_room(room);
  perform public.mobile_heartbeat(room);
  if (select count(*) from mobile_private.push_queue where room_id=room)<>1 then raise exception 'Rapid rejoin pushed'; end if;
  insert into mobile_test_results values('profile/create/list/presence and join notification dedup');
  result:=public.mobile_send_message(room,receipt,payload);
  if result->>'user_id'<>a::text or result->>'display_name'<>'Alice' or not (result->>'is_creator')::boolean then raise exception 'Sender identity incorrect'; end if;
  if exists(select 1 from realtime.messages where topic='mobile-room:'||room and event='message') then raise exception 'Ciphertext archived in Realtime'; end if;
  begin perform public.mobile_send_message(room,receipt,payload); raise exception 'Duplicate message accepted'; exception when raise_exception then if sqlerrm<>'Message already submitted.' then raise; end if; end;
  begin perform public.mobile_send_message(room,gen_random_uuid(),payload||'{"plaintext":"leak"}'::jsonb); raise exception 'Unbounded payload accepted'; exception when raise_exception then if sqlerrm<>'Invalid encrypted message.' then raise; end if; end;
  insert into mobile_test_results values('server-bound sender, replay rejection, encrypted shape, no ciphertext archive');
  for n in 1..4 loop perform public.mobile_send_message(room,gen_random_uuid(),payload); end loop;
  begin perform public.mobile_send_message(room,gen_random_uuid(),payload); raise exception 'Rate limit missing'; exception when raise_exception then if sqlerrm<>'Please wait before trying again.' then raise; end if; end;
  insert into mobile_test_results values('five message / five second limit');
  begin perform public.mobile_admin_overview(); raise exception 'Creator got admin'; exception when insufficient_privilege then null; end;
  begin perform public.mobile_admin_close_room(room); raise exception 'Creator closed room'; exception when insufficient_privilege then null; end;
  request_id:=(public.mobile_request_deletion(room)->>'id')::uuid;
  if exists(select 1 from public.mobile_rooms where id=room and closed_at is not null) then raise exception 'Request bypassed admin approval'; end if;
  insert into mobile_test_results values('creator cannot administer and deletion requires approval');
  perform public.mobile_create_room(encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex'),'Second');
  perform public.mobile_create_room(encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex'),'Third');
  begin perform public.mobile_create_room(encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex'),'Fourth'); raise exception 'Room cap missing'; exception when raise_exception then if sqlerrm<>'Room capacity reached. Try again later.' then raise; end if; end;
  insert into mobile_test_results values('three active rooms per creator');

  perform set_config('request.jwt.claims',jsonb_build_object('sub',b,'role','authenticated','session_id',sb,'app_metadata',jsonb_build_object('provider','google'))::text,true);
  perform public.mobile_profile('Bob');
  if mobile_private.can_receive('mobile-room:'||room) then raise exception 'Outsider can subscribe'; end if;
  begin perform public.mobile_send_message(room,gen_random_uuid(),payload); raise exception 'Outsider can send'; exception when insufficient_privilege then null; end;
  if jsonb_array_length(public.mobile_rooms())<>0 then raise exception 'Outsider can list rooms'; end if;
  perform public.mobile_join_room(hash);
  if not mobile_private.can_receive('mobile-room:'||room) then raise exception 'Member cannot subscribe'; end if;
  result:=public.mobile_send_message(room,gen_random_uuid(),payload);
  if (result->>'is_creator')::boolean or result->>'user_id'<>b::text then raise exception 'Member impersonated creator'; end if;
  begin perform public.mobile_request_deletion(room); raise exception 'Noncreator requested deletion'; exception when insufficient_privilege then null; end;
  insert into mobile_test_results values('outsider cannot list/subscribe/send; valid invitation grants member access');
  perform public.mobile_watch_room(room,false);
  if (select watched from public.mobile_memberships where room_id=room and user_id=b) then raise exception 'Unwatch failed'; end if;
  insert into mobile_test_results values('notification opt-out');

  perform set_config('request.jwt.claims',jsonb_build_object('sub',adm,'role','authenticated','session_id',sd,'app_metadata',jsonb_build_object('provider','google'))::text,true);
  result:=public.mobile_profile('Admin');
  if not (result->>'is_admin')::boolean then raise exception 'Verified Google admin rejected'; end if;
  result:=public.mobile_admin_overview();
  if jsonb_array_length(result->'profiles')<3 or not result ? 'counts' then raise exception 'Admin overview incomplete'; end if;
  if mobile_private.can_receive('mobile-room:'||room) then raise exception 'Admin has hidden room access'; end if;
  perform public.mobile_admin_publish_notice('Fixture notice','Test body');
  if jsonb_array_length(public.mobile_notices())<1 then raise exception 'Notice unreadable'; end if;
  perform public.mobile_admin_publish_release(2147483000,'fixture','https://example.invalid/test.apk',repeat('a',64),'fixture');
  if public.mobile_latest_release()->>'version'<>'fixture' then raise exception 'Release unavailable'; end if;
  perform public.mobile_admin_set_disabled(b,true);
  insert into mobile_test_results values('verified Google admin, bounded overview, notices, updates; no implicit chat access');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',b,'role','authenticated','session_id',sb,'app_metadata',jsonb_build_object('provider','google'))::text,true);
  begin perform public.mobile_rooms(); raise exception 'Disabled account accepted'; exception when insufficient_privilege then null; end;
  insert into mobile_test_results values('disabled account loses API access immediately');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',adm,'role','authenticated','session_id',sd,'app_metadata',jsonb_build_object('provider','google'))::text,true);
  perform public.mobile_admin_review_deletion(request_id,true);
  if not exists(select 1 from public.mobile_rooms where id=room and closed_at is not null) then raise exception 'Admin approval did not close room'; end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',a,'role','authenticated','session_id',sa,'app_metadata',jsonb_build_object('provider','google'))::text,true);
  begin perform public.mobile_heartbeat(room); raise exception 'Closed room accepted'; exception when insufficient_privilege then null; end;
  insert into mobile_test_results values('admin deletion approval closes room and blocks future activity');
end $$;
set local role authenticated;
do $$begin
  perform public.mobile_profile(null);
  begin perform user_id from public.mobile_profiles; raise exception 'Direct profile/IP read allowed'; exception when insufficient_privilege then null; end;
  begin perform public.mobile_edge_device(auth.uid(),null,false,null,null); raise exception 'Edge-only endpoint allowed'; exception when insufficient_privilege then null; end;
  begin perform mobile_private.rate_limit(auth.uid(),'bypass',999,interval '1 second'); raise exception 'Internal helper allowed'; exception when insufficient_privilege then null; end;
  begin insert into realtime.messages(id,topic,event,payload,private,extension) values(gen_random_uuid(),'mobile-room:'||gen_random_uuid(),'message','{}',true,'broadcast');
    raise exception 'Direct client Broadcast write allowed'; exception when insufficient_privilege then null; end;
  insert into mobile_test_results values('authenticated role can use profile RPC but cannot read IP table, call service/helpers, or forge Broadcast');
end $$;
reset role;
select check_name,'PASS' as status from mobile_test_results;
rollback;

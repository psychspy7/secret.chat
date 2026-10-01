-- Synthetic fixtures only; every change is rolled back.
begin;
create temporary table v15_results(check_name text) on commit drop;
do $$
declare
  u uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); adm uuid:=gen_random_uuid();
  su uuid:=gen_random_uuid(); sb uuid:=gen_random_uuid(); sa uuid:=gen_random_uuid();
  room uuid; room24 uuid; permanent uuid; req uuid; before_expiry timestamptz; result jsonb;
  admin_email text:='VIRATANAND1221@GMAIL.COM'; hash text:=encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex');
begin
  if exists(select 1 from auth.users where email=admin_email) then raise exception 'Fixture address exists'; end if;
  insert into auth.users(id,role,aud,email,email_confirmed_at,raw_app_meta_data,created_at,updated_at)
    values(u,'authenticated','authenticated','v15-'||u||'@example.invalid',now(),'{"provider":"email","providers":["email"]}',now(),now()),
      (b,'authenticated','authenticated','v15-'||b||'@example.invalid',now(),'{"provider":"email","providers":["email"]}',now(),now()),
      (adm,'authenticated','authenticated',admin_email,now(),'{"provider":"email","providers":["email"]}',now(),now());
  insert into auth.identities(user_id,provider_id,provider,identity_data,created_at,updated_at)
    select id,id::text,'email',jsonb_build_object('sub',id::text,'email',email),now(),now() from auth.users where id in(u,b,adm);
  insert into auth.sessions(id,user_id,created_at,updated_at) values(su,u,now(),now()),(sb,b,now(),now()),(sa,adm,now(),now());
  perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated','session_id',su,'app_metadata',jsonb_build_object('provider','email'))::text,true);
  result:=public.mobile_profile('Email user');
  if (result->>'is_admin')::boolean then raise exception 'Ordinary email became admin'; end if;
  update auth.users set email_confirmed_at=null where id=u;
  begin perform public.mobile_profile(null); raise exception 'Unconfirmed email accepted'; exception when insufficient_privilege then null; end;
  update auth.users set email_confirmed_at=now() where id=u;
  insert into v15_results values('confirmed email accepted; unconfirmed email rejected');
  room:=(public.mobile_create_room_v15(hash,'One hour',1,false)->>'id')::uuid;
  room24:=(public.mobile_create_room_v15(encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex'),'24 hours',24,false)->>'id')::uuid;
  if (select expires_at from public.mobile_rooms where id=room)<>now()+interval '1 hour' or (select expires_at from public.mobile_rooms where id=room24)<>now()+interval '24 hours' then raise exception 'Duration incorrect'; end if;
  begin perform public.mobile_create_room_v15(hash,'Invalid',0,false); raise exception 'Zero duration accepted'; exception when raise_exception then if sqlerrm<>'Choose a room duration from 1 to 24 hours.' then raise; end if; end;
  begin perform public.mobile_create_room_v15(hash,'Invalid',25,false); raise exception '25-hour duration accepted'; exception when raise_exception then if sqlerrm<>'Choose a room duration from 1 to 24 hours.' then raise; end if; end;
  begin perform public.mobile_create_room_v15(hash,'Permanent',24,true); raise exception 'User permanent group accepted'; exception when insufficient_privilege then null; end;
  insert into v15_results values('1–24 hour bounds; permanent groups denied to ordinary users');
  req:=(public.mobile_request_extension(room,4)->>'id')::uuid;
  if (public.mobile_request_extension(room,2)->>'id')::uuid<>req then raise exception 'Duplicate pending extension'; end if;
  begin perform public.mobile_admin_extend_room(room,2); raise exception 'User admin extend accepted'; exception when insufficient_privilege then null; end;
  insert into v15_results values('creator request deduplicated; creator cannot directly extend');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',b,'role','authenticated','session_id',sb,'app_metadata',jsonb_build_object('provider','email'))::text,true);
  perform public.mobile_profile('Participant'); perform public.mobile_join_room(hash);
  begin perform public.mobile_request_extension(room,2); raise exception 'Participant extension accepted'; exception when insufficient_privilege then null; end;
  insert into v15_results values('noncreator cannot request an extension');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',adm,'role','authenticated','session_id',sa,'app_metadata',jsonb_build_object('provider','email'))::text,true);
  if not (public.mobile_profile('Admin')->>'is_admin')::boolean then raise exception 'Verified email admin denied'; end if;
  if mobile_private.can_receive('mobile-room:'||room) then raise exception 'Admin got implicit message access'; end if;
  result:=public.mobile_admin_overview();
  if not result ? 'extension_requests' or not result ? 'counts' then raise exception 'Overview missing fields'; end if;
  select expires_at into before_expiry from public.mobile_rooms where id=room;
  perform public.mobile_admin_review_extension(req,true);
  if (select expires_at from public.mobile_rooms where id=room)<>before_expiry+interval '4 hours' then raise exception 'Approved duration incorrect'; end if;
  begin perform public.mobile_admin_review_extension(req,true); raise exception 'Double approval accepted'; exception when raise_exception then if sqlerrm<>'This request has already been reviewed.' then raise; end if; end;
  insert into v15_results values('verified email admin; approve once; metadata-only access');
  perform public.mobile_admin_extend_room(room,3);
  if (select expires_at from public.mobile_rooms where id=room)<>before_expiry+interval '7 hours' then raise exception 'Direct extension incorrect'; end if;
  permanent:=(public.mobile_create_room_v15(encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex'),'Permanent admin',24,true)->>'id')::uuid;
  if (select expires_at from public.mobile_rooms where id=permanent)<>'infinity'::timestamptz then raise exception 'Permanent group expires'; end if;
  begin perform public.mobile_request_extension(permanent,2); raise exception 'Permanent extension request accepted'; exception when insufficient_privilege then null; end;
  insert into v15_results values('admin direct extension and permanent group');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated','session_id',su,'app_metadata',jsonb_build_object('provider','email'))::text,true);
  req:=(public.mobile_request_extension(room24,2)->>'id')::uuid;
  select expires_at into before_expiry from public.mobile_rooms where id=room24;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',adm,'role','authenticated','session_id',sa,'app_metadata',jsonb_build_object('provider','email'))::text,true);
  perform public.mobile_admin_review_extension(req,false);
  if (select expires_at from public.mobile_rooms where id=room24)<>before_expiry or (select status from public.mobile_extension_requests where id=req)<>'rejected' then raise exception 'Decline changed expiry'; end if;
  update public.mobile_rooms set expires_at=now()-interval '1 hour' where id=room24;
  perform public.mobile_admin_extend_room(room24,2);
  if (select expires_at from public.mobile_rooms where id=room24)<>now()+interval '2 hours' then raise exception 'Expired extension incorrect'; end if;
  insert into v15_results values('decline preserves expiry; admin restores an expired open room');
end $$;
select check_name,'PASS' as status from v15_results;
rollback;

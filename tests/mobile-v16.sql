-- Synthetic accounts only. All data, keys, votes and releases are rolled back.
begin;
create temporary table v16_results(check_name text) on commit drop;
do $$
declare
 a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); adm uuid:=gen_random_uuid();
 sa uuid:=gen_random_uuid(); sb uuid:=gen_random_uuid(); sc uuid:=gen_random_uuid(); sd uuid:=gen_random_uuid();
 claims_a text; claims_b text; claims_c text; claims_adm text;
 room uuid; research_id uuid; req uuid; result jsonb; msg uuid; archived integer;
 filler_room uuid; filler_rooms uuid[]:='{}'; remaining integer; amount integer;
 hash text:=encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex');
 rhash text:=encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex');
 payload jsonb:=jsonb_build_object('v',1,'iv','AAAAAAAAAAAAAAAA','data','AAAAAAAAAAAAAAAAAAAAAA','sent_at',now());
begin
 if exists(select 1 from auth.users where email='VIRATANAND1221@GMAIL.COM') then raise exception 'Fixture address exists'; end if;
 insert into auth.users(id,role,aud,email,email_confirmed_at,raw_app_meta_data,created_at,updated_at)
 values(a,'authenticated','authenticated','v16-'||a||'@example.invalid',now(),'{"provider":"email"}',now(),now()),
 (b,'authenticated','authenticated','v16-'||b||'@example.invalid',now(),'{"provider":"email"}',now(),now()),
 (c,'authenticated','authenticated','v16-'||c||'@example.invalid',now(),'{"provider":"email"}',now(),now()),
 (adm,'authenticated','authenticated','VIRATANAND1221@GMAIL.COM',now(),'{"provider":"email"}',now(),now());
 insert into auth.identities(user_id,provider_id,provider,identity_data,created_at,updated_at)
 select id,id::text,'email',jsonb_build_object('sub',id::text,'email',email),now(),now() from auth.users where id in(a,b,c,adm);
 insert into auth.sessions(id,user_id,created_at,updated_at) values(sa,a,now(),now()),(sb,b,now(),now()),(sc,c,now(),now()),(sd,adm,now(),now());
 claims_a:=jsonb_build_object('sub',a,'role','authenticated','session_id',sa,'app_metadata',jsonb_build_object('provider','email'))::text;
 claims_b:=jsonb_build_object('sub',b,'role','authenticated','session_id',sb,'app_metadata',jsonb_build_object('provider','email'))::text;
 claims_c:=jsonb_build_object('sub',c,'role','authenticated','session_id',sc,'app_metadata',jsonb_build_object('provider','email'))::text;
 claims_adm:=jsonb_build_object('sub',adm,'role','authenticated','session_id',sd,'app_metadata',jsonb_build_object('provider','email'))::text;
 perform set_config('request.jwt.claims',claims_a,true); perform public.mobile_profile('Alice');
 begin perform public.mobile_v16('vault-get'); raise exception 'User read vault'; exception when insufficient_privilege then null; end;
 begin perform public.mobile_v16('vault-set',null,'{}'); raise exception 'User wrote vault'; exception when insufficient_privilege then null; end;
 room:=(public.mobile_v16('create',null,jsonb_build_object('code_hash',hash,'label','Private fixture','hours',24))->>'id')::uuid;
 perform public.mobile_send_message(room,gen_random_uuid(),payload);
 if exists(select 1 from mobile_private.research_messages where room_id=room) then raise exception 'Private message archived'; end if;
 insert into v16_results values('ordinary accounts cannot access vault; private messages have no archive');
 perform set_config('request.jwt.claims',claims_adm,true); perform public.mobile_profile('Fixture administrator');
 begin perform public.mobile_v16('admin-archive',room); raise exception 'Private admin read accepted'; exception when insufficient_privilege then null; end;
 -- Only a disposable encrypted vault fixture. Do not change a configured real vault.
 if not exists(select 1 from mobile_private.research_vault) then
   perform public.mobile_v16('vault-set',null,jsonb_build_object('public_jwk',jsonb_build_object('kty','RSA','e','AQAB','n',repeat('A',342)),
     'encrypted_private',jsonb_build_object('v',1,'salt',repeat('A',22),'iv',repeat('A',16),'data',repeat('A',1500))));
 end if;
 perform set_config('request.jwt.claims',claims_a,true);
 research_id:=(public.mobile_v16('create',null,jsonb_build_object('code_hash',rhash,'label','Research fixture','hours',24,'research',true,'research_ack',true,'wrapped_invitation',repeat('A',342)))->>'id')::uuid;
 perform set_config('request.jwt.claims',claims_b,true); perform public.mobile_profile('Bob');
 begin perform public.mobile_join_room(rhash); raise exception 'Old client bypassed consent'; exception when raise_exception then if sqlerrm<>'Review and accept the research room notice before joining.' then raise; end if; end;
 perform public.mobile_v16('join',null,jsonb_build_object('code_hash',rhash,'research_ack',true));
 perform public.mobile_join_room(hash);
 begin perform public.mobile_v16('admin-clear',room); raise exception 'Member cleared without quorum'; exception when insufficient_privilege then null; end;
 payload:=payload||jsonb_build_object('v',2,'epoch',1);
 msg:=gen_random_uuid(); perform public.mobile_send_message_v16(research_id,msg,payload);
 if not exists(select 1 from mobile_private.research_messages where id=msg) then raise exception 'Consented research message not archived'; end if;
 perform set_config('request.jwt.claims',claims_adm,true);
 if jsonb_array_length(public.mobile_v16('admin-archive',research_id)->'messages')<>1 then raise exception 'Admin research export missing'; end if;
 insert into v16_results values('research consent enforced for old and new clients; admin archive restricted to research rooms');
 -- Old content remains readable. Capacity refuses new content instead of pruning.
 update mobile_private.research_messages set created_at=now()-interval '30 days' where id=msg;
 if jsonb_array_length(public.mobile_v16('admin-archive',research_id)->'messages')<>1 then raise exception 'Old research content hidden'; end if;
 if exists(select 1 from cron.job where command ilike '%delete%research_messages%') then raise exception 'Automatic research deletion still scheduled'; end if;
 insert into mobile_private.research_messages(id,room_id,envelope)
 select gen_random_uuid(),research_id,'{}'::jsonb from generate_series(1,999);
 perform set_config('request.jwt.claims',claims_b,true);
 begin perform public.mobile_send_message_v16(research_id,gen_random_uuid(),payload); raise exception 'Full room accepted content';
 exception when raise_exception then if sqlerrm not like 'Research archive full.%' then raise; end if; end;
 if (select count(*) from mobile_private.research_messages where room_id=research_id)<>1000
   or not exists(select 1 from mobile_private.research_messages where id=msg) then raise exception 'Capacity removed saved content'; end if;
 -- Remove disposable filler only, preserving the fixture's old message.
 delete from mobile_private.research_messages where room_id=research_id and id<>msg;
 insert into v16_results values('old research messages retained and readable; per-room capacity blocks sends without deletion');
 perform set_config('request.jwt.claims',claims_adm,true);
 select 4096-count(*) into remaining from mobile_private.research_messages;
 while remaining>0 loop
   filler_room:=(public.mobile_v16('create',null,jsonb_build_object('code_hash',encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex'),
     'label','Capacity fixture','hours',24,'research',true,'research_ack',true,'wrapped_invitation',repeat('A',342)))->>'id')::uuid;
   filler_rooms:=array_append(filler_rooms,filler_room); amount:=least(1000,remaining);
   insert into mobile_private.research_messages(id,room_id,envelope) select gen_random_uuid(),filler_room,'{}'::jsonb from generate_series(1,amount);
   remaining:=remaining-amount;
 end loop;
 perform set_config('request.jwt.claims',claims_b,true);
 begin perform public.mobile_send_message_v16(research_id,gen_random_uuid(),payload); raise exception 'Full global archive accepted content';
 exception when raise_exception then if sqlerrm not like 'Research archive full.%' then raise; end if; end;
 if (select count(*) from mobile_private.research_messages)<>4096 then raise exception 'Global capacity removed content'; end if;
 perform public.mobile_send_message(room,gen_random_uuid(),payload);
 delete from mobile_private.research_messages where room_id=any(filler_rooms);
 insert into v16_results values('global research capacity blocks only research sends; private messages continue');
 perform set_config('request.jwt.claims',claims_a,true);
 req:=(public.mobile_v16('request-clear',room)->'clear_request'->>'id')::uuid;
 if (select chat_epoch from public.mobile_rooms where id=room)<>1 then raise exception 'Cleared before unanimous approval'; end if;
 perform set_config('request.jwt.claims',claims_c,true); perform public.mobile_profile('Carol');
 begin perform public.mobile_v16('vote-clear',room,jsonb_build_object('request_id',req,'approve',true)); raise exception 'Outsider voted'; exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claims',claims_b,true);
 perform public.mobile_v16('vote-clear',room,jsonb_build_object('request_id',req,'approve',true));
 if (select chat_epoch from public.mobile_rooms where id=room)<>2 or (select status from mobile_private.clear_requests where id=req)<>'approved' then raise exception 'Unanimous approval did not clear'; end if;
 begin perform public.mobile_send_message_v16(room,gen_random_uuid(),payload); raise exception 'Stale epoch sent'; exception when raise_exception then if sqlerrm not like 'Invalid message%' then raise; end if; end;
 perform public.mobile_send_message_v16(room,gen_random_uuid(),payload||jsonb_build_object('epoch',2));
 insert into v16_results values('unanimous clear advances epoch; outsiders and stale messages rejected');
 perform set_config('request.jwt.claims',claims_a,true);
 perform public.mobile_v16('request-clear',room);
 select id into req from mobile_private.clear_requests where room_id=room and status='pending';
 perform set_config('request.jwt.claims',claims_b,true);
 perform public.mobile_v16('vote-clear',room,jsonb_build_object('request_id',req,'approve',false));
 if (select chat_epoch from public.mobile_rooms where id=room)<>2 or (select status from mobile_private.clear_requests where id=req)<>'rejected' then raise exception 'Decline did not stop clear'; end if;
 perform set_config('request.jwt.claims',claims_a,true); perform public.mobile_v16('request-clear',room);
 perform set_config('request.jwt.claims',claims_c,true); perform public.mobile_join_room(hash);
 if exists(select 1 from mobile_private.clear_requests where room_id=room and status='pending') then raise exception 'New member did not cancel vote'; end if;
 insert into v16_results values('one decline stops clear; membership change cancels pending quorum');
 perform set_config('request.jwt.claims',claims_adm,true);
 perform public.mobile_v16('admin-clear',research_id);
 if exists(select 1 from mobile_private.research_messages where room_id=research_id) then raise exception 'Admin clear retained research archive'; end if;
 if (select chat_epoch from public.mobile_rooms where id=research_id)<>2 then raise exception 'Admin clear epoch incorrect'; end if;
 insert into v16_results values('administrator clearing removes research archive and advances the shared epoch');
 -- Release outbox permissions, bounded batches and per-device completion.
 insert into mobile_private.devices(token,user_id) values('v16-fixture-device-'||a,a),('v16-fixture-device-'||b,b),('v16-fixture-device-'||c,c);
 update public.mobile_profiles set disabled=true where user_id=c;
 select coalesce(max(version_code),0)+100 into archived from public.mobile_releases;
 perform public.mobile_admin_publish_release(archived,'fixture','https://example.invalid/fixture.apk',repeat('a',64),'Rollback fixture only');
 if not exists(select 1 from mobile_private.release_deliveries where version_code=archived and token='v16-fixture-device-'||a)
   or exists(select 1 from mobile_private.release_deliveries where version_code=archived and token='v16-fixture-device-'||c) then raise exception 'Release recipients incorrect'; end if;
 begin perform public.mobile_edge_release_batch(); raise exception 'User claimed release tokens'; exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 result:=public.mobile_edge_release_batch();
 if jsonb_array_length(result)>32 or not exists(select 1 from jsonb_array_elements(result) e where e->>'token'='v16-fixture-device-'||a and e->>'user_id'=a::text) then raise exception 'Release batch incorrect'; end if;
 perform public.mobile_edge_release_finish(jsonb_build_array(jsonb_build_object('version_code',archived,'token','v16-fixture-device-'||a)));
 if not exists(select 1 from mobile_private.release_deliveries where version_code=archived and token='v16-fixture-device-'||a and completed_at is not null) then raise exception 'Release completion missing'; end if;
 insert into v16_results values('release notification outbox excludes disabled users; bounded service-only batches and completion');
 for result in select to_jsonb(p.oid) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'mobile\_%' escape '\' loop
   if has_function_privilege('anon',(result#>>'{}')::oid,'execute') then raise exception 'Anonymous mobile RPC exposed'; end if;
 end loop;
 if has_function_privilege('authenticated','mobile_private.clear_room(uuid)','execute') or has_function_privilege('authenticated','public.mobile_edge_release_batch(jsonb)','execute') then raise exception 'Internal control exposed'; end if;
 insert into v16_results values('anonymous and service-only RPC permissions checked');
end $$;
select check_name,'PASS' as status from v16_results;
rollback;

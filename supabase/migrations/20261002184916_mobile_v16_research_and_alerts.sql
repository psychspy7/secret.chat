-- SecretChat v1.6: opt-in research rooms, unanimous clearing, and generic alerts.
-- Existing private room contents remain unavailable to administrators.
alter table public.mobile_rooms add column chat_epoch integer not null default 1 check(chat_epoch>0);
alter table public.mobile_rooms add column research boolean not null default false;
alter table public.mobile_rooms add column wrapped_invitation text;
alter table public.mobile_memberships add column research_ack_at timestamptz;
alter table mobile_private.push_queue add column event_type text not null default 'room_join' check(event_type in ('room_join','room_message'));
create table mobile_private.research_vault (
  singleton boolean primary key default true check(singleton), public_jwk jsonb not null,
  encrypted_private jsonb not null, created_at timestamptz not null default now()
);
create table mobile_private.research_messages (
  id uuid primary key, room_id uuid not null references public.mobile_rooms(id) on delete cascade,
  envelope jsonb not null, created_at timestamptz not null default now()
);
create index research_messages_room_time on mobile_private.research_messages(room_id,created_at desc,id);
create table mobile_private.clear_requests (
  id uuid primary key default gen_random_uuid(), room_id uuid not null references public.mobile_rooms(id) on delete cascade,
  requested_by uuid not null references public.mobile_profiles(user_id), epoch integer not null,
  members uuid[] not null, votes jsonb not null default '{}',
  status text not null default 'pending' check(status in ('pending','approved','rejected','cancelled','expired')),
  created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '24 hours'
);
create unique index clear_requests_pending on mobile_private.clear_requests(room_id) where status='pending';
create index clear_requests_expiry on mobile_private.clear_requests(expires_at);
create table mobile_private.release_deliveries (
  version_code integer not null references public.mobile_releases(version_code), token text not null,
  created_at timestamptz not null default now(), claimed_at timestamptz, completed_at timestamptz,
  primary key(version_code,token)
);
alter table mobile_private.research_vault enable row level security;
alter table mobile_private.research_messages enable row level security;
alter table mobile_private.clear_requests enable row level security;
alter table mobile_private.release_deliveries enable row level security;
revoke all on mobile_private.research_vault,mobile_private.research_messages,mobile_private.clear_requests,mobile_private.release_deliveries from public,anon,authenticated;

create or replace function mobile_private.room_json(p_room_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
select jsonb_build_object('id',r.id,'label',r.label,'created_by',r.created_by,'created_at',r.created_at,
 'expires_at',r.expires_at,'closed_at',r.closed_at,'is_creator',r.created_by=auth.uid(),'chat_epoch',r.chat_epoch,'research',r.research,
 'member_count',(select count(*) from public.mobile_memberships m where m.room_id=r.id),
 'online_count',(select count(*) from public.mobile_memberships m where m.room_id=r.id and m.left_at is null and m.last_seen_at>now()-interval '90 seconds'))
from public.mobile_rooms r where r.id=p_room_id;
$$;

create function mobile_private.clear_room(p_room_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_epoch integer;
begin
 -- Internal only. Caller has already authenticated and locked this room.
 update public.mobile_rooms set chat_epoch=chat_epoch+1 where id=p_room_id returning chat_epoch into v_epoch;
 if v_epoch is null then raise exception 'Room unavailable.'; end if;
 delete from mobile_private.research_messages where room_id=p_room_id;
 update mobile_private.clear_requests set status='cancelled' where room_id=p_room_id and status='pending';
 perform realtime.send(jsonb_build_object('room_id',p_room_id,'chat_epoch',v_epoch),'cleared','mobile-room:'||p_room_id,true);
 return mobile_private.room_json(p_room_id);
end; $$;
revoke all on function mobile_private.clear_room(uuid) from public,anon,authenticated,service_role;

create function mobile_private.v16(p_action text,p_room_id uuid default null,p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=mobile_private.require_user(); v_room public.mobile_rooms; v_req mobile_private.clear_requests;
 v_code text; v_id uuid; v_members uuid[]; v_result jsonb; v_jwk jsonb; v_vault jsonb; v_new boolean;
begin
 if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>18000 then raise exception 'Invalid request.'; end if;
 if p_action='public-key' then return (select public_jwk from mobile_private.research_vault); end if;
 if p_action in ('vault-get','vault-set','admin-archive','admin-clear') then
   perform mobile_private.require_admin();
   if p_action='vault-get' then return (select encrypted_private from mobile_private.research_vault); end if;
   if p_action='vault-set' then
     v_jwk:=p_data->'public_jwk'; v_vault:=p_data->'encrypted_private';
     if v_jwk->>'kty' is distinct from 'RSA' or v_jwk->>'e' is distinct from 'AQAB' or length(v_jwk->>'n') is distinct from 342
       or (v_jwk->>'n')!~'^[A-Za-z0-9_-]+$' or v_vault->>'v' is distinct from '1'
       or length(v_vault->>'salt') is distinct from 22 or length(v_vault->>'iv') is distinct from 16
       or (v_vault->>'data') is null or length(v_vault->>'data') not between 1000 and 6000 then raise exception 'Invalid research vault.'; end if;
     -- No private RSA fields may be provided as the public key.
     insert into mobile_private.research_vault(public_jwk,encrypted_private) values(
       jsonb_build_object('kty','RSA','n',v_jwk->>'n','e','AQAB','alg','RSA-OAEP-256','key_ops',jsonb_build_array('encrypt'),'ext',true),v_vault);
     return jsonb_build_object('ready',true);
   end if;
   select * into v_room from public.mobile_rooms where id=p_room_id for update;
   if v_room.id is null then raise exception 'Room unavailable.'; end if;
   if p_action='admin-clear' then return mobile_private.clear_room(p_room_id); end if;
   if not v_room.research then raise exception 'Private rooms have no administrator archive.' using errcode='42501'; end if;
   return jsonb_build_object('room',mobile_private.room_json(p_room_id),'wrapped_invitation',v_room.wrapped_invitation,
     'messages',coalesce((select jsonb_agg(envelope order by created_at,id) from
       (select id,envelope,created_at from mobile_private.research_messages where room_id=p_room_id and created_at>now()-interval '7 days' order by created_at desc,id desc limit 1000)a),'[]'::jsonb));
 end if;
 if p_action='create' then
   v_result:=mobile_private.create_room_v15(p_data->>'code_hash',p_data->>'label',(p_data->>'hours')::integer,coalesce((p_data->>'permanent')::boolean,false));
   v_id:=(v_result->>'id')::uuid;
   if coalesce((p_data->>'research')::boolean,false) then
     if not exists(select 1 from mobile_private.research_vault) then raise exception 'The administrator must set up the research vault first.'; end if;
     if (p_data->>'research_ack') is distinct from 'true' or length(p_data->>'wrapped_invitation') is distinct from 342
       or (p_data->>'wrapped_invitation')!~'^[A-Za-z0-9_-]+$' then raise exception 'Research consent and a valid encrypted invitation are required.'; end if;
     update public.mobile_rooms set research=true,wrapped_invitation=p_data->>'wrapped_invitation' where id=v_id;
     update public.mobile_memberships set research_ack_at=now() where room_id=v_id and user_id=v_uid;
   end if;
   return mobile_private.room_json(v_id);
 end if;
 if p_action in ('invite','join') then
   perform mobile_private.rate_limit(v_uid,'invite-v16',20,interval '1 minute');
   v_code:=p_data->>'code_hash';
   select * into v_room from public.mobile_rooms where code_hash=v_code and closed_at is null and expires_at>now() for update;
   if v_room.id is null then raise exception 'This invitation is unavailable.'; end if;
   if p_action='invite' then return jsonb_build_object('label',v_room.label,'research',v_room.research); end if;
   if v_room.research and (p_data->>'research_ack') is distinct from 'true' then raise exception 'Review and accept the research room notice before joining.'; end if;
   v_new:=not exists(select 1 from public.mobile_memberships where room_id=v_room.id and user_id=v_uid);
   if v_new then
     if not exists(select 1 from public.mobile_profiles where user_id=v_uid) then raise exception 'Choose a display name first.'; end if;
     if (select count(*) from public.mobile_memberships where room_id=v_room.id)>=100 then raise exception 'This room is full.'; end if;
     if (select count(*) from public.mobile_memberships m join public.mobile_rooms r on r.id=m.room_id where m.user_id=v_uid and r.closed_at is null and r.expires_at>now())>=20 then raise exception 'You have reached the joined room limit.'; end if;
     insert into public.mobile_memberships(room_id,user_id,research_ack_at) values(v_room.id,v_uid,case when v_room.research then now() end);
     update mobile_private.clear_requests set status='cancelled' where room_id=v_room.id and status='pending';
   elsif v_room.research then update public.mobile_memberships set research_ack_at=coalesce(research_ack_at,now()) where room_id=v_room.id and user_id=v_uid;
   end if;
   return mobile_private.room_json(v_room.id);
 end if;
 -- State is available for owned archived rooms too so offline devices eventually clear.
 if not exists(select 1 from public.mobile_memberships where room_id=p_room_id and user_id=v_uid) then raise exception 'Room access required.' using errcode='42501'; end if;
 select * into v_room from public.mobile_rooms where id=p_room_id for update;
 update mobile_private.clear_requests set status='expired' where room_id=p_room_id and status='pending' and expires_at<=now();
 if p_action='request-clear' then
   perform mobile_private.require_member(p_room_id);
   perform mobile_private.rate_limit(v_uid,'clear-request',3,interval '1 day');
   select array_agg(m.user_id order by m.user_id) into v_members from public.mobile_memberships m join public.mobile_profiles p on p.user_id=m.user_id where m.room_id=p_room_id and not p.disabled;
   insert into mobile_private.clear_requests(room_id,requested_by,epoch,members,votes)
     values(p_room_id,v_uid,v_room.chat_epoch,v_members,jsonb_build_object(v_uid::text,true)) returning * into v_req;
 elsif p_action='vote-clear' then
   perform mobile_private.require_member(p_room_id);
   select * into v_req from mobile_private.clear_requests where id=(p_data->>'request_id')::uuid and room_id=p_room_id and status='pending' for update;
   if v_req.id is null or not(v_uid=any(v_req.members)) or v_req.epoch<>v_room.chat_epoch or v_req.expires_at<=now() then raise exception 'This vote is no longer available.'; end if;
   if jsonb_typeof(p_data->'approve') is distinct from 'boolean' then raise exception 'Choose approve or decline.'; end if;
   -- A vote is final for this request. A rejected request can be proposed again.
   if v_req.votes ? v_uid::text then raise exception 'You have already voted.'; end if;
   update mobile_private.clear_requests set votes=votes||jsonb_build_object(v_uid::text,(p_data->>'approve')::boolean) where id=v_req.id returning * into v_req;
 elsif p_action<>'state' then raise exception 'Unknown action.';
 end if;
 if v_req.id is not null then
   if exists(select 1 from jsonb_each(v_req.votes) where value='false'::jsonb) then
     update mobile_private.clear_requests set status='rejected' where id=v_req.id;
   elsif not exists(select 1 from unnest(v_req.members) member where v_req.votes->member::text is distinct from 'true'::jsonb) then
     perform mobile_private.clear_room(p_room_id);
     update mobile_private.clear_requests set status='approved' where id=v_req.id;
   end if;
   perform realtime.send(jsonb_build_object('room_id',p_room_id),'clear-vote','mobile-room:'||p_room_id,true);
 end if;
 return jsonb_build_object('room',mobile_private.room_json(p_room_id),'clear_request',
   (select to_jsonb(q) from mobile_private.clear_requests q where room_id=p_room_id order by created_at desc,id desc limit 1));
end; $$;
create function public.mobile_v16(p_action text,p_room_id uuid default null,p_data jsonb default '{}') returns jsonb
language sql security invoker set search_path='' as $$ select mobile_private.v16(p_action,p_room_id,p_data) $$;
revoke all on function mobile_private.v16(text,uuid,jsonb),public.mobile_v16(text,uuid,jsonb) from public,anon;
grant execute on function mobile_private.v16(text,uuid,jsonb),public.mobile_v16(text,uuid,jsonb) to authenticated;

-- Preserve old private clients, but never let an old client bypass research consent.
create or replace function mobile_private.join_room(p_code_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin return mobile_private.v16('join',null,jsonb_build_object('code_hash',p_code_hash,'research_ack',false)); end; $$;

create function mobile_private.send_v16(p_room_id uuid,p_message_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=mobile_private.require_user(); v_room public.mobile_rooms; v_sent timestamptz; v_envelope jsonb; v_epoch integer;
begin
 select * into v_room from public.mobile_rooms where id=p_room_id for update;
 perform mobile_private.require_member(p_room_id);
 if v_room.research and not exists(select 1 from public.mobile_memberships where room_id=p_room_id and user_id=v_uid and research_ack_at is not null) then raise exception 'Research consent required.'; end if;
 v_epoch:=case when p_payload->>'v'='1' then 1 else (p_payload->>'epoch')::integer end;
 if p_message_id is null or p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>14500
   or (p_payload->>'v') is null or p_payload->>'v' not in ('1','2') or v_epoch is distinct from v_room.chat_epoch
   or (v_room.research and p_payload->>'v'='1')
   or length(p_payload->>'iv') is distinct from 16 or (p_payload->>'iv')!~'^[A-Za-z0-9_-]+$'
   or (p_payload->>'data') is null or length(p_payload->>'data') not between 22 and 14000 or (p_payload->>'data')!~'^[A-Za-z0-9_-]+$'
   or p_payload->>'sent_at' is null
   or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('v','iv','data','sent_at','epoch'))
   then raise exception 'Invalid message or chat changed. Refresh the room and update SecretChat.'; end if;
 v_sent:=(p_payload->>'sent_at')::timestamptz;
 if abs(extract(epoch from now()-v_sent))>300 then raise exception 'Check the time on your device.'; end if;
 perform mobile_private.rate_limit(v_uid,'send',5,interval '5 seconds');
 insert into mobile_private.message_receipts(message_id,user_id) values(p_message_id,v_uid);
 select jsonb_build_object('id',p_message_id,'room_id',p_room_id,'user_id',v_uid,'display_name',p.display_name,
   'is_creator',v_room.created_by=v_uid,'payload',p_payload,'created_at',now()) into v_envelope from public.mobile_profiles p where user_id=v_uid;
 if v_room.research then
   insert into mobile_private.research_messages(id,room_id,envelope) values(p_message_id,p_room_id,v_envelope);
   delete from mobile_private.research_messages where room_id=p_room_id and id in
     (select id from mobile_private.research_messages where room_id=p_room_id order by created_at desc,id desc offset 1000);
 end if;
 insert into mobile_private.push_queue(id,room_id,actor_id,event_type) values(p_message_id,p_room_id,v_uid,'room_message');
 return v_envelope;
end; $$;
create or replace function mobile_private.send_message(p_room_id uuid,p_message_id uuid,p_payload jsonb) returns jsonb
language sql security definer set search_path='' as $$ select mobile_private.send_v16(p_room_id,p_message_id,p_payload) $$;
-- Updated private rooms still use v1 at epoch 1 for compatibility. v2 binds reset epochs.
create function public.mobile_send_message_v16(p_room_id uuid,p_message_id uuid,p_payload jsonb) returns jsonb
language sql security invoker set search_path='' as $$ select mobile_private.send_v16(p_room_id,p_message_id,p_payload) $$;
revoke all on function mobile_private.send_v16(uuid,uuid,jsonb),public.mobile_send_message_v16(uuid,uuid,jsonb) from public,anon;
grant execute on function mobile_private.send_v16(uuid,uuid,jsonb),public.mobile_send_message_v16(uuid,uuid,jsonb) to authenticated;

create or replace function mobile_private.claim_push(p_actor_id uuid,p_room_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_event mobile_private.push_queue;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Service access required.' using errcode='42501'; end if;
 select * into v_event from mobile_private.push_queue where actor_id=p_actor_id and room_id=p_room_id and completed_at is null
   and (claimed_at is null or claimed_at<now()-interval '2 minutes') and created_at>now()-interval '5 minutes'
   order by created_at,id limit 1 for update skip locked;
 if v_event.id is null then return null; end if;
 update mobile_private.push_queue set claimed_at=now() where id=v_event.id;
 return jsonb_build_object('id',v_event.id,'type',v_event.event_type,'room_id',p_room_id,'devices',coalesce((select jsonb_agg(jsonb_build_object('token',d.token,'user_id',d.user_id))
   from mobile_private.devices d join public.mobile_memberships m on m.user_id=d.user_id join public.mobile_profiles p on p.user_id=d.user_id join public.mobile_rooms r on r.id=m.room_id
   where m.room_id=p_room_id and m.user_id<>p_actor_id and m.watched and not p.disabled and r.closed_at is null and r.expires_at>now() and d.updated_at>now()-interval '60 days'
     -- Foreground clients beep after authenticated live delivery. Avoid a second FCM beep.
     and (m.left_at is not null or m.last_seen_at is null or m.last_seen_at<now()-interval '45 seconds')),'[]'::jsonb));
end; $$;

-- Release notification outbox covers every currently registered opted-in device.
create function mobile_private.enqueue_release() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into mobile_private.release_deliveries(version_code,token)
 select new.version_code,d.token from mobile_private.devices d join public.mobile_profiles p on p.user_id=d.user_id where not p.disabled and d.updated_at>now()-interval '60 days';
 perform realtime.send(jsonb_build_object('version_code',new.version_code),'update','mobile-updates',true);
 return new;
end; $$;
revoke all on function mobile_private.enqueue_release() from public,anon,authenticated,service_role;
create trigger mobile_release_notifications after insert on public.mobile_releases for each row execute function mobile_private.enqueue_release();
create function mobile_private.release_batch(p_finish jsonb default '[]') returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_latest integer;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Service access required.' using errcode='42501'; end if;
 if jsonb_typeof(p_finish)<>'array' or jsonb_array_length(p_finish)>100 then raise exception 'Invalid batch.'; end if;
 update mobile_private.release_deliveries d set completed_at=now() from jsonb_array_elements(p_finish) f
   where d.version_code=(f->>'version_code')::integer and d.token=f->>'token';
 select max(version_code) into v_latest from public.mobile_releases;
 return coalesce((with batch as (select d.version_code,d.token from mobile_private.release_deliveries d
   join mobile_private.devices dev on dev.token=d.token join public.mobile_profiles p on p.user_id=dev.user_id
   where d.version_code=v_latest and d.completed_at is null and d.created_at>now()-interval '7 days' and not p.disabled
     and (d.claimed_at is null or d.claimed_at<now()-interval '2 minutes') order by d.token limit 100 for update of d skip locked),
 claimed as(update mobile_private.release_deliveries d set claimed_at=now() from batch b where d.version_code=b.version_code and d.token=b.token returning d.version_code,d.token)
 select jsonb_agg(to_jsonb(c)||jsonb_build_object('user_id',dev.user_id)) from claimed c join mobile_private.devices dev on dev.token=c.token),'[]'::jsonb);
end; $$;
create function public.mobile_edge_release_batch(p_finish jsonb default '[]') returns jsonb
language sql security invoker set search_path='' as $$select mobile_private.release_batch(p_finish)$$;
revoke all on function mobile_private.release_batch(jsonb),public.mobile_edge_release_batch(jsonb) from public,anon,authenticated;
grant execute on function mobile_private.release_batch(jsonb),public.mobile_edge_release_batch(jsonb) to service_role;
create function mobile_private.release_finish(p_finish jsonb) returns void
language plpgsql security definer set search_path='' as $$
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Service access required.' using errcode='42501'; end if;
 if jsonb_typeof(p_finish) is distinct from 'array' or jsonb_array_length(p_finish)>100 then raise exception 'Invalid batch.'; end if;
 update mobile_private.release_deliveries d set completed_at=now() from jsonb_array_elements(p_finish) f
   where d.version_code=(f->>'version_code')::integer and d.token=f->>'token';
end; $$;
create function public.mobile_edge_release_finish(p_finish jsonb) returns void
language sql security invoker set search_path='' as $$select mobile_private.release_finish(p_finish)$$;
revoke all on function mobile_private.release_finish(jsonb),public.mobile_edge_release_finish(jsonb) from public,anon,authenticated;
grant execute on function mobile_private.release_finish(jsonb),public.mobile_edge_release_finish(jsonb) to service_role;

create policy "Mobile signed in release alerts" on realtime.messages for select to authenticated
using (realtime.topic()='mobile-updates' and mobile_private.require_user() is not null);
select cron.schedule('secretchat-v16-retention','17 * * * *',$job$
 delete from mobile_private.research_messages where created_at<now()-interval '7 days';
 delete from mobile_private.clear_requests where expires_at<now()-interval '7 days';
 delete from mobile_private.release_deliveries where created_at<now()-interval '7 days';
$job$);

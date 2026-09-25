-- Public creators can request closure, but only the permanent administrator can
-- clear or close rooms. A request never changes room state by itself.
create or replace function app_private.can_read_room(p_room_id uuid)
returns boolean language sql stable security definer set search_path=''
as $$
  select exists(select 1 from public.rooms r where r.id=p_room_id and r.is_active
    and (r.expires_at is null or r.expires_at>now())
    and (app_private.is_admin() or exists(
      select 1 from public.room_members m where m.room_id=r.id
        and m.user_id=auth.uid() and m.is_active)))
$$;

drop policy if exists rooms_authorized_read on public.rooms;
create policy rooms_authorized_read on public.rooms for select to authenticated
using (
  (select app_private.is_admin()) or app_private.can_read_room(id)
  or (closed_at>now()-interval '2 minutes'
    and app_private.is_room_member(id,false))
);

create table public.room_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null
);
create unique index room_deletion_one_pending
  on public.room_deletion_requests(room_id) where status='pending';
create index room_deletion_pending_created
  on public.room_deletion_requests(created_at) where status='pending';
alter table public.room_deletion_requests enable row level security;
revoke all on public.room_deletion_requests from public,anon,authenticated;

create or replace function public.request_room_deletion(p_room_id uuid)
returns uuid language plpgsql security definer set search_path=''
as $$
declare v_id uuid;
begin
  if auth.uid() is null
    or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) is false
  then raise exception 'forbidden' using errcode='42501'; end if;
  perform 1 from public.rooms r where r.id=p_room_id
    and r.host_user_id=auth.uid() and r.is_public_created and r.is_active
    and r.expires_at>now() for update;
  if not found then raise exception 'forbidden' using errcode='42501'; end if;
  select d.id into v_id from public.room_deletion_requests d
    where d.room_id=p_room_id and d.status='pending';
  if v_id is null then
    insert into public.room_deletion_requests(room_id,requested_by)
      values(p_room_id,auth.uid()) returning id into v_id;
  end if;
  return v_id;
end $$;

create or replace function public.list_room_deletion_requests()
returns table(id uuid,room_id uuid,requested_by uuid,created_at timestamptz)
language plpgsql stable security definer set search_path=''
as $$
begin
  if not app_private.is_admin() then
    raise exception 'forbidden' using errcode='42501';
  end if;
  return query select d.id,d.room_id,d.requested_by,d.created_at
    from public.room_deletion_requests d where d.status='pending'
    order by d.created_at;
end $$;

create or replace function public.clear_room_messages(p_room_id uuid)
returns void language plpgsql security definer set search_path=''
as $$
begin
  if not app_private.is_admin() then
    raise exception 'forbidden' using errcode='42501';
  end if;
  perform 1 from public.rooms r where r.id=p_room_id and r.is_active
    for update;
  if not found then raise exception 'room unavailable' using errcode='P0002'; end if;
  delete from public.messages where room_id=p_room_id;
  update public.rooms set chat_epoch=chat_epoch+1 where id=p_room_id;
end $$;

create or replace function public.close_room(p_room_id uuid)
returns void language plpgsql security definer set search_path=''
as $$
begin
  if not app_private.is_admin() then
    raise exception 'forbidden' using errcode='42501';
  end if;
  perform 1 from public.rooms r where r.id=p_room_id and r.is_active
    for update;
  if not found then raise exception 'room unavailable' using errcode='P0002'; end if;
  update public.rooms set is_active=false,closed_at=now(),chat_epoch=chat_epoch+1
    where id=p_room_id;
  delete from public.messages where room_id=p_room_id;
  update public.room_members set is_active=false,name_cipher='{"v":0}',last_seen=now()
    where room_id=p_room_id;
  update public.room_deletion_requests
    set status='approved',reviewed_at=now(),reviewed_by=auth.uid()
    where room_id=p_room_id and status='pending';
end $$;

create or replace function public.review_room_deletion(p_request_id uuid,p_approve boolean)
returns void language plpgsql security definer set search_path=''
as $$
declare v_request public.room_deletion_requests; v_room_id uuid;
begin
  if not app_private.is_admin() then
    raise exception 'forbidden' using errcode='42501';
  end if;
  select d.room_id into v_room_id from public.room_deletion_requests d
    where d.id=p_request_id and d.status='pending';
  if v_room_id is null then raise exception 'request unavailable' using errcode='P0002'; end if;
  perform 1 from public.rooms r where r.id=v_room_id for update;
  select * into v_request from public.room_deletion_requests d
    where d.id=p_request_id and d.status='pending' for update;
  if not found then raise exception 'request unavailable' using errcode='P0002'; end if;
  if p_approve then
    perform public.close_room(v_request.room_id);
  else
    update public.room_deletion_requests
      set status='rejected',reviewed_at=now(),reviewed_by=auth.uid()
      where id=p_request_id;
  end if;
end $$;

revoke all on function public.request_room_deletion(uuid),
  public.list_room_deletion_requests(),public.review_room_deletion(uuid,boolean)
  from public,anon,authenticated;
grant execute on function public.request_room_deletion(uuid),
  public.list_room_deletion_requests(),public.review_room_deletion(uuid,boolean)
  to authenticated;

-- Public notices are intentionally plaintext so they can appear before sign-in.
create table public.site_notices (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 100),
  body text not null check (length(btrim(body)) between 1 and 1000),
  link_url text check (link_url is null or
    (length(link_url)<=500 and link_url ~ '^https://[A-Za-z0-9]')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.site_notices enable row level security;
revoke all on public.site_notices from public,anon,authenticated;
grant select on public.site_notices to anon,authenticated;
grant insert,update,delete on public.site_notices to authenticated;
create policy notices_public_read on public.site_notices for select
  to anon,authenticated using (is_active);
create policy notices_admin_read on public.site_notices for select
  to authenticated using ((select app_private.is_admin()));
create policy notices_admin_insert on public.site_notices for insert
  to authenticated with check ((select app_private.is_admin()));
create policy notices_admin_update on public.site_notices for update
  to authenticated using ((select app_private.is_admin()))
  with check ((select app_private.is_admin()));
create policy notices_admin_delete on public.site_notices for delete
  to authenticated using ((select app_private.is_admin()));

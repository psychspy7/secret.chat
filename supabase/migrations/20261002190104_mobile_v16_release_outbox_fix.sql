create or replace function mobile_private.release_batch(p_finish jsonb default '[]') returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_latest integer; v_result jsonb;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Service access required.' using errcode='42501'; end if;
 if jsonb_typeof(p_finish)<>'array' or jsonb_array_length(p_finish)>100 then raise exception 'Invalid batch.'; end if;
 update mobile_private.release_deliveries d set completed_at=now() from jsonb_array_elements(p_finish) f
   where d.version_code=(f->>'version_code')::integer and d.token=f->>'token';
 select max(version_code) into v_latest from public.mobile_releases;
 with batch as (select d.version_code,d.token from mobile_private.release_deliveries d
   join mobile_private.devices dev on dev.token=d.token join public.mobile_profiles p on p.user_id=dev.user_id
   where d.version_code=v_latest and d.completed_at is null and d.created_at>now()-interval '7 days' and not p.disabled
     and (d.claimed_at is null or d.claimed_at<now()-interval '2 minutes') order by d.token limit 32 for update of d skip locked),
 claimed as(update mobile_private.release_deliveries d set claimed_at=now() from batch b where d.version_code=b.version_code and d.token=b.token returning d.version_code,d.token)
 select jsonb_agg(to_jsonb(c)||jsonb_build_object('user_id',dev.user_id)) into v_result from claimed c join mobile_private.devices dev on dev.token=c.token;
 return coalesce(v_result,'[]'::jsonb);
end; $$;
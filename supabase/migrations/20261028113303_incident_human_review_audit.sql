-- Record who confirmed a review-required incident and prevent its status from
-- leaving review until an authenticated user explicitly records that review.
alter table public.incidents
  add column human_verified_at timestamptz,
  add column human_verified_by uuid references auth.users (id) on delete restrict,
  add constraint incidents_human_verification_audit_pair check (
    (human_verified_at is null and human_verified_by is null)
    or (human_verified_at is not null and human_verified_by is not null)
  );

-- Supabase projects can have broad default grants on public tables. Revoke
-- client-role table privileges before restoring only the app's required access.
revoke all on public.stores, public.store_memberships, public.incidents
  from anon, authenticated;
grant usage on schema public to authenticated;
grant select on public.stores, public.store_memberships, public.incidents to authenticated;
grant update (assigned_department, status, human_verified_at, human_verified_by)
  on public.incidents to authenticated;

drop trigger incidents_enforce_food_safety_escalation on public.incidents;

create or replace function public.enforce_food_safety_escalation()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  verifying_user_id uuid;
begin
  if tg_op = 'INSERT' then
    if lower(trim(new.category)) = 'food safety' then
      new.severity = 'Critical';
      new.requires_human_verification = true;
      new.escalation_required = true;
      new.status = 'Requires human verification';
      new.human_verified_at = null;
      new.human_verified_by = null;
    end if;
    return new;
  end if;

  if old.human_verified_at is not null then
    if new.human_verified_at is distinct from old.human_verified_at
      or new.human_verified_by is distinct from old.human_verified_by then
      raise exception 'Human-review audit records cannot be changed.'
        using errcode = 'check_violation';
    end if;
  elsif new.human_verified_at is not null or new.human_verified_by is not null then
    if not old.requires_human_verification then
      raise exception 'This incident does not require human verification.'
        using errcode = 'check_violation';
    end if;
    verifying_user_id = (select auth.uid());
    if verifying_user_id is null then
      raise exception 'An authenticated user must confirm the human review.'
        using errcode = 'check_violation';
    end if;
    new.human_verified_at = pg_catalog.now();
    new.human_verified_by = verifying_user_id;
  end if;

  if lower(trim(new.category)) = 'food safety' then
    new.severity = 'Critical';
    new.requires_human_verification = true;
    new.escalation_required = true;
  end if;

  if old.requires_human_verification
    and old.human_verified_at is null
    and new.human_verified_at is null
    and new.status not in ('Requires human verification', 'Needs human review') then
    raise exception 'Confirm human review before changing this incident status.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger incidents_enforce_food_safety_escalation
before insert or update on public.incidents
for each row execute function public.enforce_food_safety_escalation();

revoke all on function public.enforce_food_safety_escalation() from public, anon, authenticated;

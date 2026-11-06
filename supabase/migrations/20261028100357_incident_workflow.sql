-- Authenticated users can read and update incidents only for stores where
-- an administrator has granted membership. Incident inserts go through FastAPI
-- after it validates the user and membership. No sample data is seeded.

create table public.stores (
  id uuid primary key default gen_random_uuid(),
  store_code text not null unique check (length(trim(store_code)) > 0),
  name text not null check (length(trim(name)) > 0),
  region text not null check (length(trim(region)) > 0),
  created_at timestamptz not null default now()
);

create table public.store_memberships (
  user_id uuid not null references auth.users (id) on delete cascade,
  store_id uuid not null references public.stores (id) on delete cascade,
  role text not null default 'associate'
    check (role in ('associate', 'manager', 'regional_manager')),
  created_at timestamptz not null default now(),
  primary key (user_id, store_id)
);

create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id) on delete restrict,
  created_by uuid not null default auth.uid() references auth.users (id) on delete restrict,
  feedback_text text not null check (length(trim(feedback_text)) between 1 and 2000),
  source text not null check (length(trim(source)) between 1 and 80),
  category text not null check (length(trim(category)) between 1 and 120),
  severity text not null check (severity in ('Critical', 'High', 'Medium', 'Low', 'Unclassified')),
  actionability text not null check (actionability in ('actionable', 'needs_review', 'informational')),
  recommended_department text not null check (length(trim(recommended_department)) between 1 and 120),
  assigned_department text not null check (length(trim(assigned_department)) between 1 and 120),
  recommended_action text not null check (length(trim(recommended_action)) between 1 and 1000),
  explanation text not null check (length(trim(explanation)) between 1 and 1000),
  status text not null check (status in (
    'Open', 'In review', 'Resolved', 'Requires human verification',
    'Needs human review', 'Informational'
  )),
  requires_human_verification boolean not null default false,
  escalation_required boolean not null default false,
  classification_method text not null default 'transparent_rules',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index incidents_store_created_at_idx
  on public.incidents (store_id, created_at desc);
create index incidents_store_category_created_at_idx
  on public.incidents (store_id, category, created_at desc);

create function public.set_incident_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = pg_catalog.now();
  return new;
end;
$$;

create trigger incidents_set_updated_at
before update on public.incidents
for each row execute function public.set_incident_updated_at();

create function public.enforce_food_safety_escalation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if lower(trim(new.category)) = 'food safety' then
    new.severity = 'Critical';
    new.requires_human_verification = true;
    new.escalation_required = true;
    new.status = 'Requires human verification';
  end if;
  return new;
end;
$$;

create trigger incidents_enforce_food_safety_escalation
before insert on public.incidents
for each row execute function public.enforce_food_safety_escalation();

revoke all on function public.set_incident_updated_at() from public, anon, authenticated;
revoke all on function public.enforce_food_safety_escalation() from public, anon, authenticated;

alter table public.stores enable row level security;
alter table public.store_memberships enable row level security;
alter table public.incidents enable row level security;

revoke all on public.stores, public.store_memberships, public.incidents from anon, authenticated;
grant usage on schema public to authenticated;
grant select on public.stores, public.store_memberships to authenticated;
grant select on public.incidents to authenticated;
grant update (assigned_department, status) on public.incidents to authenticated;

create policy "users can read their own store memberships"
  on public.store_memberships for select to authenticated
  using (user_id = (select auth.uid()));

create policy "users can read stores they belong to"
  on public.stores for select to authenticated
  using (
    exists (
      select 1
      from public.store_memberships as membership
      where membership.store_id = stores.id
        and membership.user_id = (select auth.uid())
    )
  );

create policy "store members can read incidents"
  on public.incidents for select to authenticated
  using (
    exists (
      select 1
      from public.store_memberships as membership
      where membership.store_id = incidents.store_id
        and membership.user_id = (select auth.uid())
    )
  );

create policy "store members can update incidents"
  on public.incidents for update to authenticated
  using (
    exists (
      select 1
      from public.store_memberships as membership
      where membership.store_id = incidents.store_id
        and membership.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1
      from public.store_memberships as membership
      where membership.store_id = incidents.store_id
        and membership.user_id = (select auth.uid())
    )
  );

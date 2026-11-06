-- R5 reporting inputs: deduplicated issue clusters retain every supporting
-- quote, and rates use an explicitly supplied transaction denominator.
-- Imports must supply the period boundaries used by the organizer contract.

create table public.incident_evidence (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents (id) on delete cascade,
  source_record_id text check (source_record_id is null or length(trim(source_record_id)) between 1 and 200),
  feedback_text text not null check (length(trim(feedback_text)) between 1 and 2000),
  source text not null check (length(trim(source)) between 1 and 80),
  received_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index incident_evidence_incident_received_idx
  on public.incident_evidence (incident_id, received_at desc);
create unique index incident_evidence_source_record_unique_idx
  on public.incident_evidence (source, source_record_id)
  where source_record_id is not null;

create table public.store_weekly_transactions (
  store_id uuid not null references public.stores (id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  total_transactions bigint not null check (total_transactions >= 0),
  import_batch_id uuid not null default gen_random_uuid(),
  source_reference text check (source_reference is null or length(trim(source_reference)) between 1 and 200),
  loaded_at timestamptz not null default now(),
  primary key (store_id, period_start),
  check (period_end > period_start)
);

alter table public.incident_evidence enable row level security;
alter table public.store_weekly_transactions enable row level security;

revoke all on public.incident_evidence, public.store_weekly_transactions from anon, authenticated;
grant select on public.incident_evidence, public.store_weekly_transactions to authenticated;
grant select on public.stores, public.store_memberships to service_role;
grant select, insert on public.incident_evidence to service_role;
grant select, insert on public.incidents to service_role;
grant select, insert on public.store_weekly_transactions to service_role;

create policy "store members can read incident evidence"
  on public.incident_evidence for select to authenticated
  using (
    exists (
      select 1 from public.incidents as incident
      join public.store_memberships as membership on membership.store_id = incident.store_id
      where incident.id = incident_evidence.incident_id
        and membership.user_id = (select auth.uid())
    )
  );

create policy "store members can read weekly transaction totals"
  on public.store_weekly_transactions for select to authenticated
  using (
    exists (
      select 1 from public.store_memberships as membership
      where membership.store_id = store_weekly_transactions.store_id
        and membership.user_id = (select auth.uid())
    )
  );

-- One row per store, explicit period and category. A null category row keeps
-- weeks with no incidents visible; issue_volume counts deduplicated clusters,
-- while evidence_volume counts the original source records supporting them.
create view public.store_weekly_issue_rates
with (security_invoker = true)
as
select
  transactions.store_id,
  store.region,
  transactions.period_start,
  transactions.period_end,
  incidents.category,
  count(distinct incidents.id)::bigint as issue_volume,
  count(distinct evidence.id)::bigint as evidence_volume,
  transactions.total_transactions,
  case
    when transactions.total_transactions > 0
      then count(distinct incidents.id)::numeric / transactions.total_transactions
    else null
  end as normalized_issue_rate,
  (count(distinct incidents.id) filter (where incidents.severity = 'Critical'))::bigint as critical_issue_volume
from public.store_weekly_transactions as transactions
join public.stores as store on store.id = transactions.store_id
left join public.incidents as incidents
  on incidents.store_id = transactions.store_id
  and (
    exists (
      select 1 from public.incident_evidence as period_evidence
      where period_evidence.incident_id = incidents.id
        and period_evidence.received_at >= transactions.period_start
        and period_evidence.received_at < transactions.period_end
    )
    or (
      not exists (
        select 1 from public.incident_evidence as any_evidence
        where any_evidence.incident_id = incidents.id
      )
      and incidents.created_at >= transactions.period_start
      and incidents.created_at < transactions.period_end
    )
  )
left join public.incident_evidence as evidence
  on evidence.incident_id = incidents.id
  and evidence.received_at >= transactions.period_start
  and evidence.received_at < transactions.period_end
group by
  transactions.store_id,
  store.region,
  transactions.period_start,
  transactions.period_end,
  incidents.category,
  transactions.total_transactions;

revoke all on public.store_weekly_issue_rates from anon, authenticated;
grant select on public.store_weekly_issue_rates to authenticated;

-- Insert an issue cluster and all source quotes atomically. FastAPI verifies
-- identity and store membership; only its server-side service_role may call it.
create function public.create_incident_with_evidence(p_incident jsonb, p_evidence jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  inserted_incident public.incidents%rowtype;
  inserted_evidence jsonb;
begin
  if pg_catalog.jsonb_typeof(p_incident) is distinct from 'object' then
    raise exception 'Incident input must be an object.' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_evidence) is distinct from 'array' then
    raise exception 'Evidence input must be an array.' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_evidence) < 1 then
    raise exception 'At least one evidence record is required.' using errcode = '22023';
  end if;

  insert into public.incidents (
    store_id, created_by, feedback_text, source, category, severity,
    actionability, recommended_department, assigned_department,
    recommended_action, explanation, status, requires_human_verification,
    escalation_required, classification_method
  ) values (
    (p_incident ->> 'store_id')::uuid,
    (p_incident ->> 'created_by')::uuid,
    p_incident ->> 'feedback_text',
    p_incident ->> 'source',
    p_incident ->> 'category',
    p_incident ->> 'severity',
    p_incident ->> 'actionability',
    p_incident ->> 'recommended_department',
    p_incident ->> 'assigned_department',
    p_incident ->> 'recommended_action',
    p_incident ->> 'explanation',
    p_incident ->> 'status',
    (p_incident ->> 'requires_human_verification')::boolean,
    (p_incident ->> 'escalation_required')::boolean,
    coalesce(p_incident ->> 'classification_method', 'transparent_rules')
  ) returning * into inserted_incident;

  insert into public.incident_evidence (incident_id, source_record_id, feedback_text, source, received_at)
  select
    inserted_incident.id,
    nullif(record.evidence ->> 'source_record_id', ''),
    record.evidence ->> 'feedback_text',
    record.evidence ->> 'source',
    coalesce(nullif(record.evidence ->> 'received_at', '')::timestamptz, pg_catalog.now())
  from pg_catalog.jsonb_array_elements(p_evidence) as record(evidence);

  select coalesce(
    pg_catalog.jsonb_agg(pg_catalog.to_jsonb(evidence_row) order by evidence_row.received_at),
    '[]'::jsonb
  )
    into inserted_evidence
  from public.incident_evidence as evidence_row
  where evidence_row.incident_id = inserted_incident.id;

  return pg_catalog.jsonb_build_object(
    'incident', pg_catalog.to_jsonb(inserted_incident),
    'evidence', inserted_evidence
  );
end;
$$;

revoke all on function public.create_incident_with_evidence(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.create_incident_with_evidence(jsonb, jsonb) to service_role;

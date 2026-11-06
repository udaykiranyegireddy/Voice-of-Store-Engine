BEGIN;
SELECT plan(21);

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'r5-member@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'r5-other@example.test');
insert into public.stores (id, store_code, name, region) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'R5-A', 'R5 Store A', 'North'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'R5-B', 'R5 Store B', 'North');
insert into public.store_memberships (user_id, store_id, role) values
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'manager');
insert into public.store_weekly_transactions (store_id, period_start, period_end, total_transactions, source_reference) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', now() - interval '1 day', now() + interval '1 day', 1000, 'test-period-with-denominator'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', now() - interval '8 days', now() - interval '7 days', 0, 'test-period-zero-denominator'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', now() - interval '1 day', now() + interval '1 day', 2000, 'other-store-period');

select ok(not has_table_privilege('anon', 'public.incident_evidence', 'SELECT'), 'anonymous users cannot read source evidence');
select ok(not has_table_privilege('authenticated', 'public.incident_evidence', 'INSERT'), 'authenticated users cannot create source evidence directly');
select ok(not has_table_privilege('authenticated', 'public.store_weekly_transactions', 'INSERT'), 'authenticated users cannot change transaction denominators');
select ok(has_table_privilege('authenticated', 'public.incident_evidence', 'SELECT'), 'authenticated role has read access subject to RLS');
select ok(has_table_privilege('authenticated', 'public.store_weekly_issue_rates', 'SELECT'), 'authenticated role can query normalized rates subject to RLS');
select ok(not has_table_privilege('anon', 'public.store_weekly_issue_rates', 'SELECT'), 'anonymous users cannot query operational rates');
select ok(has_function_privilege('service_role', 'public.create_incident_with_evidence(jsonb,jsonb)', 'EXECUTE'), 'server service role can write an issue and evidence atomically');

set local role service_role;
select is(
  (with saved as materialized (
    select public.create_incident_with_evidence(
    '{
      "store_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "created_by":"11111111-1111-4111-8111-111111111111",
      "feedback_text":"R5 RPC report",
      "source":"staff_report",
      "category":"Payment failure",
      "severity":"High",
      "actionability":"actionable",
      "recommended_department":"Digital / Technical Support",
      "assigned_department":"Digital / Technical Support",
      "recommended_action":"Review payment processing.",
      "explanation":"A test report.",
      "status":"Open",
      "requires_human_verification":false,
      "escalation_required":false,
      "classification_method":"transparent_rules"
    }'::jsonb,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('feedback_text', 'R5 RPC report', 'source', 'staff_report', 'received_at', pg_catalog.now()),
      pg_catalog.jsonb_build_object('feedback_text', 'Second original quote', 'source', 'customer_feedback', 'received_at', pg_catalog.now())
    )
    ) as result
  )
  select pg_catalog.jsonb_typeof(saved.result -> 'incident') || ':'
    || pg_catalog.jsonb_array_length(saved.result -> 'evidence')::text
  from saved),
  'object:2',
  'RPC returns the inserted issue cluster and both source quotes'
);

reset role;
select is(
  (select count(*) from public.incident_evidence as evidence
   join public.incidents as incident on incident.id = evidence.incident_id
   where incident.feedback_text = 'R5 RPC report'),
  2::bigint,
  'RPC persists both original quotes'
);
select is(
  (select issue_volume from public.store_weekly_issue_rates
   where store_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
     and period_start > now() - interval '2 days'),
  1::bigint,
  'one deduplicated incident counts once despite multiple quotes'
);
select is(
  (select category from public.store_weekly_issue_rates
   where store_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
     and period_start > now() - interval '2 days'),
  'Payment failure',
  'reporting row preserves the issue category'
);
select is(
  (select evidence_volume from public.store_weekly_issue_rates
   where store_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
     and period_start > now() - interval '2 days'),
  2::bigint,
  'view separately counts all retained source evidence'
);
select is(
  (select normalized_issue_rate from public.store_weekly_issue_rates
   where store_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
     and period_start > now() - interval '2 days'),
  0.001::numeric,
  'normalized rate divides one issue by one thousand transactions'
);
select is(
  (select normalized_issue_rate from public.store_weekly_issue_rates
   where store_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
     and total_transactions = 0),
  null::numeric,
  'zero transaction denominator yields no rate'
);
select is(
  (select issue_volume from public.store_weekly_issue_rates
   where store_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
     and total_transactions = 0),
  0::bigint,
  'zero-issue weeks retain their denominator row'
);

set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
select is((select count(*) from public.store_weekly_issue_rates), 2::bigint, 'member sees both reporting periods for their store only');
select is((select count(*) from public.incident_evidence), 2::bigint, 'member can read linked evidence for their store');
select is((select count(*) from public.store_weekly_transactions), 2::bigint, 'member can read their store transaction totals');
set local request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
select is((select count(*) from public.store_weekly_issue_rates), 0::bigint, 'non-member cannot read normalized rates for another store');
select is((select count(*) from public.incident_evidence), 0::bigint, 'non-member cannot read another store evidence');
select is((select count(*) from public.store_weekly_transactions), 0::bigint, 'non-member cannot read another store transaction totals');

SELECT * FROM finish();
ROLLBACK;

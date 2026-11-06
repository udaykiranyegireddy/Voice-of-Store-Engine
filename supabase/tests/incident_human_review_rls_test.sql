BEGIN;
SELECT plan(27);

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'store-member@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'non-member@example.test');

insert into public.stores (id, store_code, name, region)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'TEST-1', 'Test Store', 'Test Region');

insert into public.store_memberships (user_id, store_id, role)
values ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'manager');

insert into public.incidents (
  id, store_id, created_by, feedback_text, source, category, severity,
  actionability, recommended_department, assigned_department,
  recommended_action, explanation, status,
  requires_human_verification, escalation_required
) values
  (
    'aaaaaaaa-0000-4000-8000-000000000001',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    'Incorrect allergen label on the product.', 'staff_report', 'Food safety', 'Low',
    'needs_review', 'Food Safety', 'Food Safety',
    'Follow store food-safety policy and verify the label.', 'Safety risk candidate.',
    'Open', false, false
  ),
  (
    'aaaaaaaa-0000-4000-8000-000000000002',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    'Something seems wrong.', 'customer_feedback', 'Unknown', 'Unclassified',
    'needs_review', 'Store Leadership', 'Store Leadership',
    'Ask a team member to review the feedback.', 'No rule matched confidently.',
    'Needs human review', true, false
  );

select is(
  (select severity from public.incidents where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'Critical',
  'food-safety insert is forced to Critical'
);
select ok(
  (select requires_human_verification and escalation_required
   from public.incidents where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'food-safety insert remains in human-verification escalation'
);
select is(
  (select status from public.incidents where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'Requires human verification',
  'food-safety insert starts in human verification'
);
select ok(
  (select human_verified_at is null and human_verified_by is null
   from public.incidents where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'a safety incident cannot be inserted as already human-verified'
);
select ok(not has_table_privilege('anon', 'public.incidents', 'SELECT'), 'anonymous users cannot read incidents');
select ok(not has_table_privilege('authenticated', 'public.incidents', 'INSERT'), 'authenticated users cannot insert incidents');
select ok(not has_table_privilege('authenticated', 'public.incidents', 'DELETE'), 'authenticated users cannot delete incidents');
select ok(not has_column_privilege('authenticated', 'public.incidents', 'severity', 'UPDATE'), 'authenticated users cannot rewrite severity');
select ok(not has_column_privilege('authenticated', 'public.incidents', 'category', 'UPDATE'), 'authenticated users cannot rewrite classification');
select ok(not has_column_privilege('authenticated', 'public.incidents', 'requires_human_verification', 'UPDATE'), 'authenticated users cannot clear the review requirement');
select ok(not has_column_privilege('authenticated', 'public.incidents', 'escalation_required', 'UPDATE'), 'authenticated users cannot clear escalation');
select ok(has_column_privilege('authenticated', 'public.incidents', 'status', 'UPDATE'), 'authenticated users can update incident status');
select ok(has_column_privilege('authenticated', 'public.incidents', 'human_verified_at', 'UPDATE'), 'authenticated users can record a human review');

set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

select is((select count(*) from public.incidents), 2::bigint, 'a store member can read the store incidents');
select throws_ok(
  $$update public.incidents set status = 'Resolved' where id = 'aaaaaaaa-0000-4000-8000-000000000001'$$,
  '23514',
  'Confirm human review before changing this incident status.',
  'a safety incident cannot be resolved before human review'
);
select results_eq(
  $$update public.incidents set human_verified_at = pg_catalog.now(), status = 'In review' where id = 'aaaaaaaa-0000-4000-8000-000000000001' returning status$$,
  $$values ('In review'::text)$$,
  'a member can explicitly record review before changing the status'
);
select is(
  (select human_verified_by from public.incidents where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'the database records the authenticated reviewer'
);
select ok(
  (select human_verified_at <= pg_catalog.now() and human_verified_at > pg_catalog.now() - interval '1 minute'
   from public.incidents where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'the database records its own review timestamp'
);
select results_eq(
  $$update public.incidents set status = 'Resolved' where id = 'aaaaaaaa-0000-4000-8000-000000000001' returning status$$,
  $$values ('Resolved'::text)$$,
  'a reviewed food-safety incident can be resolved'
);
select throws_ok(
  $$update public.incidents set human_verified_at = null where id = 'aaaaaaaa-0000-4000-8000-000000000001'$$,
  '23514',
  'Human-review audit records cannot be changed.',
  'review audit fields cannot be cleared or rewritten'
);
select throws_ok(
  $$update public.incidents set status = 'Resolved' where id = 'aaaaaaaa-0000-4000-8000-000000000002'$$,
  '23514',
  'Confirm human review before changing this incident status.',
  'ambiguous feedback also cannot leave review before verification'
);
select results_eq(
  $$update public.incidents set human_verified_at = pg_catalog.now(), status = 'In review' where id = 'aaaaaaaa-0000-4000-8000-000000000002' returning status$$,
  $$values ('In review'::text)$$,
  'a member can explicitly review ambiguous feedback'
);
select is(
  (select human_verified_by from public.incidents where id = 'aaaaaaaa-0000-4000-8000-000000000002'),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'the database records the reviewer for ambiguous feedback'
);
select results_eq(
  $$update public.incidents set status = 'Resolved' where id = 'aaaaaaaa-0000-4000-8000-000000000002' returning status$$,
  $$values ('Resolved'::text)$$,
  'reviewed ambiguous feedback can be resolved'
);
select results_eq(
  $$update public.incidents set assigned_department = 'Facilities & Maintenance' where id = 'aaaaaaaa-0000-4000-8000-000000000002' returning assigned_department$$,
  $$values ('Facilities & Maintenance'::text)$$,
  'a member can update the in-app team assignment'
);

set local request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
select is((select count(*) from public.incidents), 0::bigint, 'a non-member cannot read incidents from another store');
select results_eq(
  $$update public.incidents set status = 'Resolved' where id = 'aaaaaaaa-0000-4000-8000-000000000001' returning id$$,
  $$select null::uuid where false$$,
  'a non-member cannot update another store incident'
);

SELECT * FROM finish();
ROLLBACK;

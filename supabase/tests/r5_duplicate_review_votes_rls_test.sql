BEGIN;
SELECT plan(11);

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'reviewer-one@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'reviewer-two@example.test');

select ok(not has_table_privilege('anon', 'public.r5_duplicate_review_votes', 'SELECT'), 'anonymous users cannot read review votes');
select ok(has_table_privilege('authenticated', 'public.r5_duplicate_review_votes', 'SELECT'), 'signed-in reviewers can see shared votes');
select ok(has_table_privilege('authenticated', 'public.r5_duplicate_review_votes', 'INSERT'), 'signed-in reviewers can submit a vote');
select ok(has_table_privilege('authenticated', 'public.r5_duplicate_review_votes', 'UPDATE'), 'signed-in reviewers can change their vote');
select ok(has_table_privilege('authenticated', 'public.r5_duplicate_review_votes', 'DELETE'), 'signed-in reviewers can remove their vote');

set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

insert into public.r5_duplicate_review_votes (
  candidate_id, reviewer_id, decision, feedback_ids, store_id,
  week_index, issue_type_ids, match_type, similarity
) values (
  'EXACT-TEST', auth.uid(), 'same', array['FB-ONE', 'FB-TWO'], 'ST-TEST',
  2, array['IT01'], 'exact_text', 1.000
);

select is((select count(*) from public.r5_duplicate_review_votes), 1::bigint, 'reviewer can read the shared vote');
select is((select reviewer_id from public.r5_duplicate_review_votes where candidate_id = 'EXACT-TEST'), auth.uid(), 'vote is attributed to the signed-in reviewer');
select throws_ok(
  $$insert into public.r5_duplicate_review_votes (candidate_id, reviewer_id, decision, feedback_ids, store_id, week_index, issue_type_ids, match_type, similarity)
    values ('FAKE-OTHER', '22222222-2222-4222-8222-222222222222', 'same', array['FB-THREE', 'FB-FOUR'], 'ST-TEST', 2, array['IT01'], 'exact_text', 1.000)$$,
  '42501', 'new row violates row-level security policy for table "r5_duplicate_review_votes"',
  'reviewer cannot cast a vote for another account'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';

select is((select count(*) from public.r5_duplicate_review_votes), 1::bigint, 'other signed-in users can read the shared vote');
select is(
  (with changed as (
    update public.r5_duplicate_review_votes set decision = 'separate' where candidate_id = 'EXACT-TEST' returning 1
  ) select count(*) from changed),
  0::bigint,
  'reviewer cannot change another account vote'
);
select is(
  (with removed as (
    delete from public.r5_duplicate_review_votes where candidate_id = 'EXACT-TEST' returning 1
  ) select count(*) from removed),
  0::bigint,
  'reviewer cannot remove another account vote'
);

SELECT * FROM finish();
ROLLBACK;

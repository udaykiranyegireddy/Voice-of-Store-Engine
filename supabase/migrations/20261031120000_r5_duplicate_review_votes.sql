-- Shared human review for cross-channel candidate matches in the public R5 benchmark.
-- Reviews are votes: an authenticated user can change or remove only their own vote.
create table public.r5_duplicate_review_votes (
  candidate_id text not null check (length(trim(candidate_id)) between 1 and 80),
  reviewer_id uuid not null references auth.users (id) on delete cascade,
  decision text not null check (decision in ('same', 'separate')),
  feedback_ids text[] not null check (cardinality(feedback_ids) >= 2),
  store_id text not null check (length(trim(store_id)) between 1 and 80),
  week_index integer not null check (week_index between 1 and 26),
  issue_type_ids text[] not null default '{}',
  match_type text not null check (match_type in ('exact_text', 'near_text')),
  similarity numeric(4, 3) not null check (similarity between 0 and 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (candidate_id, reviewer_id)
);

create index r5_duplicate_review_votes_candidate_idx
  on public.r5_duplicate_review_votes (candidate_id, updated_at desc);

create trigger r5_duplicate_review_votes_set_updated_at
before update on public.r5_duplicate_review_votes
for each row execute function public.set_incident_updated_at();

alter table public.r5_duplicate_review_votes enable row level security;
revoke all on public.r5_duplicate_review_votes from anon, authenticated;
grant select, insert, update, delete on public.r5_duplicate_review_votes to authenticated;

create policy "authenticated users can read duplicate review votes"
  on public.r5_duplicate_review_votes for select to authenticated
  using (true);

create policy "users can create their own duplicate review votes"
  on public.r5_duplicate_review_votes for insert to authenticated
  with check (reviewer_id = (select auth.uid()));

create policy "users can update their own duplicate review votes"
  on public.r5_duplicate_review_votes for update to authenticated
  using (reviewer_id = (select auth.uid()))
  with check (reviewer_id = (select auth.uid()));

create policy "users can remove their own duplicate review votes"
  on public.r5_duplicate_review_votes for delete to authenticated
  using (reviewer_id = (select auth.uid()));

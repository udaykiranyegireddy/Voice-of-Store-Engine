import type { SupabaseClient } from '@supabase/supabase-js';

export type DuplicateReviewDecision = 'same' | 'separate';

export type DuplicateReviewVote = {
  candidate_id: string;
  reviewer_id: string;
  decision: DuplicateReviewDecision;
  updated_at: string;
};

export type DuplicateReviewCandidateInput = {
  candidate_id: string;
  feedback_ids: string[];
  store_id: string;
  week_index: number;
  issue_type_ids: string[];
  match_type: 'exact_text' | 'near_text';
  similarity: number;
};

export async function loadDuplicateReviewVotes(client: SupabaseClient): Promise<DuplicateReviewVote[]> {
  const { data, error } = await client
    .from('r5_duplicate_review_votes')
    .select('candidate_id,reviewer_id,decision,updated_at')
    .order('updated_at', { ascending: true });

  if (error) throw error;
  return (data ?? []) as DuplicateReviewVote[];
}

export async function saveDuplicateReviewVote(
  client: SupabaseClient,
  reviewerId: string,
  candidate: DuplicateReviewCandidateInput,
  decision: DuplicateReviewDecision | null,
): Promise<void> {
  if (decision === null) {
    const { error } = await client
      .from('r5_duplicate_review_votes')
      .delete()
      .eq('candidate_id', candidate.candidate_id)
      .eq('reviewer_id', reviewerId);
    if (error) throw error;
    return;
  }

  const { error } = await client
    .from('r5_duplicate_review_votes')
    .upsert({
      ...candidate,
      reviewer_id: reviewerId,
      decision,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'candidate_id,reviewer_id' });

  if (error) throw error;
}

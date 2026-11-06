import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadDuplicateReviewVotes,
  saveDuplicateReviewVote,
} from './duplicateReviewService.ts';

function fakeClient({ votes = [] } = {}) {
  const calls = [];
  const client = {
    from(table) {
      calls.push(['from', table]);
      return {
        select(columns) {
          calls.push(['select', columns]);
          return {
            order: async (column, options) => {
              calls.push(['order', column, options]);
              return { data: votes, error: null };
            },
          };
        },
        upsert: async (payload, options) => {
          calls.push(['upsert', payload, options]);
          return { error: null };
        },
        delete() {
          calls.push(['delete']);
          return {
            eq(column, value) {
              calls.push(['eq', column, value]);
              return {
                eq: async (secondColumn, secondValue) => {
                  calls.push(['eq', secondColumn, secondValue]);
                  return { error: null };
                },
              };
            },
          };
        },
      };
    },
  };
  return { client, calls };
}

const candidate = {
  candidate_id: 'same-store-incident-1',
  feedback_ids: ['FB-ONE', 'FB-TWO'],
  store_id: 'ST-001JY',
  week_index: 6,
  issue_type_ids: ['IT16'],
  match_type: 'near_text',
  similarity: 0.812,
};

test('loads shared reviewer votes in stable update order', async () => {
  const votes = [{
    candidate_id: candidate.candidate_id,
    reviewer_id: 'user-1',
    decision: 'same',
    updated_at: '2026-10-31T10:00:00.000Z',
  }];
  const { client, calls } = fakeClient({ votes });

  assert.deepEqual(await loadDuplicateReviewVotes(client), votes);
  assert.deepEqual(calls, [
    ['from', 'r5_duplicate_review_votes'],
    ['select', 'candidate_id,reviewer_id,decision,updated_at'],
    ['order', 'updated_at', { ascending: true }],
  ]);
});

test('saves each decision as the signed-in reviewer vote', async () => {
  const { client, calls } = fakeClient();

  await saveDuplicateReviewVote(client, 'user-1', candidate, 'same');

  const [upsertCall] = calls.filter(([name]) => name === 'upsert');
  assert.deepEqual(upsertCall[1], {
    ...candidate,
    reviewer_id: 'user-1',
    decision: 'same',
    updated_at: upsertCall[1].updated_at,
  });
  assert.equal(Number.isNaN(Date.parse(upsertCall[1].updated_at)), false);
  assert.deepEqual(upsertCall[2], { onConflict: 'candidate_id,reviewer_id' });
});

test('removes only the selected reviewer’s vote for a candidate', async () => {
  const { client, calls } = fakeClient();

  await saveDuplicateReviewVote(client, 'user-2', candidate, null);

  assert.deepEqual(calls, [
    ['from', 'r5_duplicate_review_votes'],
    ['delete'],
    ['eq', 'candidate_id', candidate.candidate_id],
    ['eq', 'reviewer_id', 'user-2'],
  ]);
});

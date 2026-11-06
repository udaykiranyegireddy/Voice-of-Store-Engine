import assert from 'node:assert/strict';
import test from 'node:test';
import { findLiveDuplicateMatch } from './liveDuplicateDetection.ts';

const now = new Date('2026-10-31T12:00:00.000Z');

function incident(overrides = {}) {
  return {
    id: 'incident-1',
    store_id: 'store-1',
    feedback_text: 'Freezer stopped cooling during the evening shift yesterday',
    source: 'staff_report',
    category: 'Equipment failure',
    created_at: '2026-10-31T10:00:00.000Z',
    ...overrides,
  };
}

test('matches normalized cross-channel text against existing incident evidence', () => {
  const result = findLiveDuplicateMatch(
    '  FREEZER stopped cooling during the evening shift yesterday!!! ',
    'store-1',
    'app_comment',
    'Equipment failure',
    [incident({ feedback_text: 'A technician is checking the freezer.' })],
    [{
      incident_id: 'incident-1',
      feedback_text: 'Freezer stopped cooling during the evening shift yesterday',
      source: 'online_review',
      received_at: '2026-10-31T09:00:00.000Z',
    }],
    now,
  );

  assert.equal(result?.incident.id, 'incident-1');
  assert.equal(result?.match_type, 'exact_text');
  assert.equal(result?.similarity, 1);
  assert.equal(result?.matched_source, 'online_review');
});

test('suggests conservative near-text matches across different channels', () => {
  const result = findLiveDuplicateMatch(
    'Freezer stopped cooling during evening shift yesteray',
    'store-1',
    'call_centre',
    'Equipment failure',
    [incident()],
    [],
    now,
  );

  assert.equal(result?.match_type, 'near_text');
  assert.ok((result?.similarity ?? 0) >= 0.76);
});

test('does not suggest same-channel, cross-store, cross-category, or old reports', () => {
  const reports = [
    incident({ source: 'app_comment' }),
    incident({ id: 'other-store', store_id: 'store-2' }),
    incident({ id: 'other-category', category: 'Stock availability' }),
    incident({ id: 'old', created_at: '2026-10-20T10:00:00.000Z' }),
  ];

  assert.equal(
    findLiveDuplicateMatch(
      'Freezer stopped cooling during the evening shift yesterday',
      'store-1',
      'app_comment',
      'Equipment failure',
      reports,
      [],
      now,
    ),
    null,
  );
});

test('ignores short incoming text rather than producing weak duplicate suggestions', () => {
  assert.equal(
    findLiveDuplicateMatch('Freezer broken', 'store-1', 'app_comment', 'Equipment failure', [incident()], [], now),
    null,
  );
});

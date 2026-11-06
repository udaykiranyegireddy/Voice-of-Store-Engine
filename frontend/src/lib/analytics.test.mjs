import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLiveCategorySignals,
  buildLiveTrend,
  findEmergingIssues,
  latestReportingPeriod,
  summarizeRegions,
  weeklyRateComparisonLabel,
} from './analytics.ts';

const now = new Date('2026-10-28T12:00:00.000Z');

test('weekly brief does not imply a zero baseline when previous-week data is missing', () => {
  assert.equal(weeklyRateComparisonLabel(0.42, null, 'no_baseline'), 'No previous-week baseline available');
  assert.equal(weeklyRateComparisonLabel(null, 0.42, 'up'), 'Rate comparison unavailable');
});

test('weekly brief labels a real rising comparison with its measured rates', () => {
  assert.equal(
    weeklyRateComparisonLabel(1.25, 0.8, 'up'),
    '↑ Rising · 1.25 vs 0.80 per 1,000 average weekly footfall',
  );
});
const weekStarts = [
  '2026-09-16T00:00:00.000Z',
  '2026-09-23T00:00:00.000Z',
  '2026-09-30T00:00:00.000Z',
  '2026-10-07T00:00:00.000Z',
  '2026-10-14T00:00:00.000Z',
];

function rate({ storeId = 'store-1', region = 'North', category = null, count = 0, transactions = 1000, periodIndex = 4 } = {}) {
  const start = weekStarts[periodIndex];
  const end = new Date(new Date(start).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  return {
    store_id: storeId,
    region,
    period_start: start,
    period_end: end,
    category,
    issue_volume: count,
    evidence_volume: count,
    total_transactions: transactions,
    normalized_issue_rate: transactions ? count / transactions : null,
    critical_issue_volume: 0,
  };
}

function incident({ category = 'Availability', createdAt = '2026-10-18T05:00:00.000Z', storeId = 'store-1', severity = 'Medium' } = {}) {
  return {
    id: `incident-${category}-${storeId}`,
    store_id: storeId,
    feedback_text: 'A test feedback record',
    source: 'staff_report',
    category,
    severity,
    actionability: 'actionable',
    recommended_department: 'Supply Chain',
    assigned_department: 'Supply Chain',
    recommended_action: 'Review the report',
    explanation: 'Test fixture only',
    status: 'Open',
    requires_human_verification: false,
    escalation_required: false,
    classification_method: 'transparent_rules',
    human_verified_at: null,
    human_verified_by: null,
    created_at: createdAt,
    updated_at: createdAt,
    store: { name: storeId, region: 'North' },
  };
}

test('buildLiveTrend counts each severity in the correct day bucket', () => {
  const rows = buildLiveTrend([
    incident({ category: 'Food safety', createdAt: now.toISOString(), severity: 'Critical' }),
    incident({ category: 'Payment failure', createdAt: now.toISOString(), severity: 'High' }),
    incident({ category: 'Unknown', createdAt: now.toISOString(), severity: 'Unclassified' }),
    incident({ category: 'Old report', createdAt: '2026-10-01T05:00:00.000Z' }),
  ], now);

  assert.equal(rows.length, 7);
  assert.equal(rows.at(-1).critical, 1);
  assert.equal(rows.at(-1).high, 1);
  assert.equal(rows.at(-1).unclassified, 1);
});

test('buildLiveCategorySignals returns the most frequent recent categories', () => {
  const rows = buildLiveCategorySignals([
    incident({ category: 'Availability', createdAt: now.toISOString() }),
    incident({ category: 'Availability', createdAt: '2026-10-27T05:00:00.000Z' }),
    incident({ category: 'Checkout', createdAt: now.toISOString() }),
    incident({ category: 'Future report', createdAt: '2026-10-29T05:00:00.000Z' }),
    incident({ category: 'Old', createdAt: '2026-10-10T05:00:00.000Z' }),
  ], now);
  assert.deepEqual(rows.slice(0, 2).map((row) => [row.category, row.count]), [['Availability', 2], ['Checkout', 1]]);
});

test('latest reporting period ignores periods that have not ended', () => {
  const rows = [rate({ periodIndex: 3 }), rate({ periodIndex: 4 }), rate({ periodIndex: 4, category: 'Future', count: 1 })];
  assert.deepEqual(latestReportingPeriod(rows, now), {
    periodStart: '2026-10-14T00:00:00.000Z',
    periodEnd: '2026-10-21T00:00:00.000Z',
  });
});

test('emerging issues compare deduplicated rates with four prior completed periods per store', () => {
  const rows = weekStarts.flatMap((_, periodIndex) => periodIndex === 4
    ? [rate({ category: 'Availability', count: 3, periodIndex })]
    : [rate({ category: null, count: 0, periodIndex })]);
  const issues = findEmergingIssues(rows, now);
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0], {
    category: 'Availability',
    latestIssueVolume: 3,
    latestRate: 0.003,
    baselineRate: 0,
    risingStoreCount: 1,
    coveredStoreCount: 1,
  });
});

test('emerging watch requires at least two issue clusters and four valid baseline periods', () => {
  const singleIssue = weekStarts.flatMap((_, periodIndex) => periodIndex === 4
    ? [rate({ category: 'Availability', count: 1, periodIndex })]
    : [rate({ category: null, count: 0, periodIndex })]);
  assert.deepEqual(findEmergingIssues(singleIssue, now), []);
  assert.deepEqual(findEmergingIssues(singleIssue.slice(2), now), []);
});

test('regional report ranks normalized rates and retains source quotes and owners', () => {
  const rows = [
    rate({ category: 'Availability', count: 2, transactions: 1000, storeId: 'store-1' }),
    rate({ category: null, count: 0, transactions: 100, storeId: 'store-2' }),
    rate({ category: 'Availability', count: 1, transactions: 1000, storeId: 'store-1', periodIndex: 3 }),
    rate({ category: null, count: 0, transactions: 100, storeId: 'store-2', periodIndex: 3 }),
  ];
  const stores = [
    { id: 'store-1', store_code: 'A', name: 'Store A', region: 'North' },
    { id: 'store-2', store_code: 'B', name: 'Store B', region: 'North' },
  ];
  const currentIncident = incident({ createdAt: '2026-10-18T05:00:00.000Z' });
  const evidence = [{
    id: 'evidence-1',
    incident_id: currentIncident.id,
    source_record_id: 'source-1',
    feedback_text: 'Milk was unavailable at Store A.',
    source: 'customer_feedback',
    received_at: '2026-10-18T05:00:00.000Z',
  }];
  const summaries = summarizeRegions(rows, stores, [currentIncident], evidence, now, weekStarts[4]);
  assert.equal(summaries[0].coveredStoreCount, 2);
  assert.equal(summaries[0].expectedStoreCount, 2);
  assert.equal(summaries[0].topIssues[0].normalizedRate, 0.001);
  assert.deepEqual(summaries[0].topIssues[0].affectedStores, ['Store A']);
  assert.deepEqual(summaries[0].topIssues[0].quotes, [{ text: 'Milk was unavailable at Store A.', source: 'customer_feedback' }]);
  assert.equal(summaries[0].topIssues[0].owner, 'Supply Chain');
  assert.equal(summaries[0].topIssues[0].trend, 'up');
  assert.equal(summaries[0].topIssues[0].severity, 'Medium');
  assert.equal(summaries[0].topIssues[0].recommendedAction, 'Review the report');
  assert.equal(summaries[0].topIssues[0].previousNormalizedRate, 0.0005);
});

test('regional brief selects the requested week instead of always using the latest', () => {
  const rows = [
    rate({ category: 'Checkout', count: 1, periodIndex: 3 }),
    rate({ category: 'Availability', count: 4, periodIndex: 4 }),
  ];
  const stores = [{ id: 'store-1', store_code: 'A', name: 'Store A', region: 'North' }];
  const selectedIncident = incident({ category: 'Checkout', createdAt: '2026-10-10T05:00:00.000Z', severity: 'High' });

  const [summary] = summarizeRegions(rows, stores, [selectedIncident], [], now, weekStarts[3]);

  assert.equal(summary.periodStart, weekStarts[3]);
  assert.deepEqual(summary.topIssues.map((issue) => issue.category), ['Checkout']);
  assert.equal(summary.topIssues[0].severity, 'High');
});

test('regional brief leaves trend unavailable when the immediately prior week is missing', () => {
  const rows = [rate({ category: 'Availability', count: 2, periodIndex: 4 })];
  const stores = [{ id: 'store-1', store_code: 'A', name: 'Store A', region: 'North' }];

  const [summary] = summarizeRegions(rows, stores, [], [], now, weekStarts[4]);

  assert.equal(summary.topIssues[0].trend, 'unavailable');
  assert.equal(summary.topIssues[0].previousNormalizedRate, null);
});

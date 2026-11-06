import type { IncidentEvidence, IncidentRecord, Store, StoreWeeklyIssueRate } from './incidentService';

export type TrendPoint = {
  day: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
  unclassified: number;
};

export type CategorySignal = {
  category: string;
  shortLabel: string;
  count: number;
};

export type EmergingIssue = {
  category: string;
  latestIssueVolume: number;
  latestRate: number;
  baselineRate: number;
  risingStoreCount: number;
  coveredStoreCount: number;
};

export type WeeklyRateTrend = 'up' | 'down' | 'flat' | 'no_baseline';

export function weeklyRateComparisonLabel(
  currentRate: number | null,
  previousRate: number | null,
  trend: WeeklyRateTrend,
  denominatorLabel = 'average weekly footfall',
): string {
  if (trend === 'no_baseline' || previousRate === null) return 'No previous-week baseline available';
  if (currentRate === null) return 'Rate comparison unavailable';
  const trendLabel = trend === 'up' ? '↑ Rising' : trend === 'down' ? '↓ Falling' : '→ Flat';
  return `${trendLabel} · ${currentRate.toFixed(2)} vs ${previousRate.toFixed(2)} per 1,000 ${denominatorLabel}`;
}

export type RegionalIssue = {
  category: string;
  issueVolume: number;
  normalizedRate: number | null;
  previousNormalizedRate: number | null;
  severity: string | null;
  affectedStores: string[];
  quotes: Array<{ text: string; source: string }>;
  owner: string;
  recommendedAction: string | null;
  trend: 'up' | 'down' | 'flat' | 'unavailable';
};

export type RegionalSummary = {
  region: string;
  periodStart: string | null;
  periodEnd: string | null;
  coveredStoreCount: number;
  expectedStoreCount: number;
  topIssues: RegionalIssue[];
};

type StorePeriod = {
  storeId: string;
  region: string;
  start: string;
  end: string;
  transactions: number;
  categories: Map<string, number>;
};

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function beginningOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function numeric(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildStorePeriods(rows: StoreWeeklyIssueRate[], now: Date): Map<string, StorePeriod[]> {
  const stores = new Map<string, Map<string, StorePeriod>>();
  for (const row of rows) {
    const endTime = new Date(row.period_end).getTime();
    if (!Number.isFinite(endTime) || endTime > now.getTime()) continue;
    const byPeriod = stores.get(row.store_id) ?? new Map<string, StorePeriod>();
    const periodKey = `${row.period_start}|${row.period_end}`;
    const period = byPeriod.get(periodKey) ?? {
      storeId: row.store_id,
      region: row.region,
      start: row.period_start,
      end: row.period_end,
      transactions: numeric(row.total_transactions),
      categories: new Map<string, number>(),
    };
    period.transactions = numeric(row.total_transactions);
    if (row.category) period.categories.set(row.category, numeric(row.issue_volume));
    byPeriod.set(periodKey, period);
    stores.set(row.store_id, byPeriod);
  }
  return new Map([...stores.entries()].map(([storeId, periods]) => [
    storeId,
    [...periods.values()].sort((left, right) => left.start.localeCompare(right.start)),
  ]));
}

export function latestReportingPeriod(
  rows: StoreWeeklyIssueRate[],
  now = new Date(),
): { periodStart: string; periodEnd: string } | null {
  const completed = rows
    .filter((row) => new Date(row.period_end).getTime() <= now.getTime())
    .sort((left, right) => right.period_end.localeCompare(left.period_end));
  return completed[0]
    ? { periodStart: completed[0].period_start, periodEnd: completed[0].period_end }
    : null;
}

export function buildLiveTrend(incidents: IncidentRecord[], now = new Date()): TrendPoint[] {
  const firstDay = beginningOfDay(now);
  firstDay.setDate(firstDay.getDate() - 6);
  const buckets = new Map<string, TrendPoint>();

  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(firstDay);
    date.setDate(firstDay.getDate() + offset);
    buckets.set(dayKey(date), {
      day: date.toLocaleDateString(undefined, { weekday: 'short' }),
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      unclassified: 0,
    });
  }

  for (const incident of incidents) {
    const bucket = buckets.get(dayKey(new Date(incident.created_at)));
    if (!bucket) continue;
    const key = incident.severity.toLowerCase() as keyof Omit<TrendPoint, 'day'>;
    if (key in bucket) bucket[key] += 1;
  }

  return [...buckets.values()];
}

export function buildLiveCategorySignals(incidents: IncidentRecord[], now = new Date()): CategorySignal[] {
  const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const counts = new Map<string, number>();

  for (const incident of incidents) {
    const createdAt = new Date(incident.created_at);
    if (createdAt < start || createdAt > now) continue;
    counts.set(incident.category, (counts.get(incident.category) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([category, count]) => ({ category, shortLabel: category, count }));
}

// A provisional watch requires two deduplicated issue clusters and a higher
// rate than the same store/category's four preceding completed periods.
// The organizer's evaluator and calibrated thresholds are not available yet.
export function findEmergingIssues(rows: StoreWeeklyIssueRate[], now = new Date()): EmergingIssue[] {
  const periodsByStore = buildStorePeriods(rows, now);
  const categoryTotals = new Map<string, {
    issueVolume: number;
    currentRates: number[];
    baselineRates: number[];
    risingStoreCount: number;
  }>();

  for (const periods of periodsByStore.values()) {
    if (periods.length < 5) continue;
    const current = periods.at(-1)!;
    if (current.transactions <= 0) continue;
    const baselinePeriods = periods.slice(0, -1).filter((period) => period.transactions > 0).slice(-4);
    if (baselinePeriods.length < 4) continue;
    const categories = new Set(periods.flatMap((period) => [...period.categories.keys()]));

    for (const category of categories) {
      const currentCount = current.categories.get(category) ?? 0;
      const baselineCount = baselinePeriods.reduce((total, period) => total + (period.categories.get(category) ?? 0), 0);
      const baselineTransactions = baselinePeriods.reduce((total, period) => total + period.transactions, 0);
      if (baselineTransactions <= 0) continue;
      const currentRate = currentCount / current.transactions;
      const baselineRate = baselineCount / baselineTransactions;
      const total = categoryTotals.get(category) ?? {
        issueVolume: 0,
        currentRates: [],
        baselineRates: [],
        risingStoreCount: 0,
      };
      total.issueVolume += currentCount;
      total.currentRates.push(currentRate);
      total.baselineRates.push(baselineRate);
      if (currentRate > baselineRate) total.risingStoreCount += 1;
      categoryTotals.set(category, total);
    }
  }

  return [...categoryTotals.entries()]
    .map(([category, total]) => ({
      category,
      latestIssueVolume: total.issueVolume,
      latestRate: total.currentRates.length
        ? total.currentRates.reduce((sum, rate) => sum + rate, 0) / total.currentRates.length
        : 0,
      baselineRate: total.baselineRates.length
        ? total.baselineRates.reduce((sum, rate) => sum + rate, 0) / total.baselineRates.length
        : 0,
      risingStoreCount: total.risingStoreCount,
      coveredStoreCount: total.currentRates.length,
    }))
    .filter((issue) => issue.latestIssueVolume >= 2 && issue.risingStoreCount > 0 && issue.latestRate > issue.baselineRate)
    .sort((left, right) => right.latestRate - left.latestRate);
}

const fallbackOwners: Record<string, string> = {
  'Equipment failure': 'Facilities & Maintenance',
  'Food safety': 'Food Safety',
  'Payment failure': 'Digital / Technical Support',
  Availability: 'Supply Chain',
  Checkout: 'Front End Operations',
  'Product quality': 'Merchandising',
  'Store environment': 'Facilities & Housekeeping',
  'Staff behavior': 'Store Leadership',
  Unknown: 'Store Operations',
};

export function summarizeRegions(
  rows: StoreWeeklyIssueRate[],
  stores: Store[],
  incidents: IncidentRecord[],
  evidence: IncidentEvidence[],
  now = new Date(),
  selectedPeriodStart?: string,
): RegionalSummary[] {
  const periodsByStore = buildStorePeriods(rows, now);
  const evidenceByIncident = new Map<string, IncidentEvidence[]>();
  for (const item of evidence) evidenceByIncident.set(item.incident_id, [...(evidenceByIncident.get(item.incident_id) ?? []), item]);

  return [...new Set(stores.map((store) => store.region))].sort().map((region) => {
    const regionStores = stores.filter((store) => store.region === region);
    const regionPeriods = rows.filter((row) => row.region === region && new Date(row.period_end).getTime() <= now.getTime());
    const periodRows = selectedPeriodStart
      ? regionPeriods.filter((row) => row.period_start === selectedPeriodStart)
      : regionPeriods;
    const latest = latestReportingPeriod(periodRows, now);
    if (!latest) {
      return { region, periodStart: null, periodEnd: null, coveredStoreCount: 0, expectedStoreCount: regionStores.length, topIssues: [] };
    }

    const currentPeriods = regionStores
      .map((store) => periodsByStore.get(store.id)?.find((period) => period.start === latest.periodStart && period.end === latest.periodEnd))
      .filter((period): period is StorePeriod => Boolean(period));
    const coveredPeriods = currentPeriods.filter((period) => period.transactions > 0);
    const categorySet = new Set(currentPeriods.flatMap((period) => [...period.categories.keys()]));
    const currentPeriodByStore = new Map(currentPeriods.map((period) => [period.storeId, period]));

    const topIssues = [...categorySet].map((category): RegionalIssue => {
      const perStoreRates = coveredPeriods.map((period) => (period.categories.get(category) ?? 0) / period.transactions);
      const issueVolume = coveredPeriods.reduce((sum, period) => sum + (period.categories.get(category) ?? 0), 0);
      const affectedStoreIds = new Set(
        coveredPeriods.filter((period) => (period.categories.get(category) ?? 0) > 0).map((period) => period.storeId),
      );
      const affectedStores = regionStores.filter((store) => affectedStoreIds.has(store.id)).map((store) => store.name);
      const periodStartTime = new Date(latest.periodStart).getTime();
      const periodEndTime = new Date(latest.periodEnd).getTime();
      const matchingIncidents = incidents.filter((incident) => {
        if (incident.category !== category || !affectedStoreIds.has(incident.store_id)) return false;
        const linkedEvidence = evidenceByIncident.get(incident.id) ?? [];
        if (linkedEvidence.length) {
          return linkedEvidence.some((item) => {
            const receivedAt = new Date(item.received_at).getTime();
            return receivedAt >= periodStartTime && receivedAt < periodEndTime;
          });
        }
        const createdAt = new Date(incident.created_at).getTime();
        return createdAt >= periodStartTime && createdAt < periodEndTime;
      });
      const quotes: RegionalIssue['quotes'] = [];
      const seenQuotes = new Set<string>();
      for (const incident of matchingIncidents) {
        const sourceRows = (evidenceByIncident.get(incident.id) ?? []).filter((item) => {
          const receivedAt = new Date(item.received_at).getTime();
          return receivedAt >= periodStartTime && receivedAt < periodEndTime;
        });
        for (const sourceRow of sourceRows) {
          const quote = sourceRow.feedback_text.trim();
          if (quote && !seenQuotes.has(quote)) {
            seenQuotes.add(quote);
            quotes.push({ text: quote, source: sourceRow.source });
          }
          if (quotes.length >= 2) break;
        }
        if (quotes.length >= 2) break;
        const fallbackQuote = incident.feedback_text.trim();
        if (!sourceRows.length && fallbackQuote && !seenQuotes.has(fallbackQuote)) {
          seenQuotes.add(fallbackQuote);
          quotes.push({ text: fallbackQuote, source: incident.source });
        }
        if (quotes.length >= 2) break;
      }

      const owners = [...new Set(matchingIncidents.map((incident) => incident.assigned_department.trim()).filter(Boolean))].sort();
      const owner = owners.length ? owners.join(', ') : fallbackOwners[category] || 'Owner review required';
      const comparableCurrentRates: number[] = [];
      const previousRates: number[] = [];
      for (const store of regionStores) {
        const storePeriods = periodsByStore.get(store.id) ?? [];
        const current = currentPeriodByStore.get(store.id);
        const prior = storePeriods.find((period) => new Date(period.end).getTime() === periodStartTime);
        if (!current || !prior || current.transactions <= 0 || prior.transactions <= 0) continue;
        comparableCurrentRates.push((current.categories.get(category) ?? 0) / current.transactions);
        previousRates.push((prior.categories.get(category) ?? 0) / prior.transactions);
      }
      const normalizedRate = coveredPeriods.length
        ? perStoreRates.reduce((sum, rate) => sum + rate, 0) / coveredPeriods.length
        : null;
      const previousNormalizedRate = previousRates.length
        ? previousRates.reduce((sum, rate) => sum + rate, 0) / previousRates.length
        : null;
      let trend: RegionalIssue['trend'] = 'unavailable';
      if (previousNormalizedRate !== null && comparableCurrentRates.length) {
        const comparableCurrentRate = comparableCurrentRates.reduce((sum, rate) => sum + rate, 0) / comparableCurrentRates.length;
        trend = comparableCurrentRate > previousNormalizedRate ? 'up' : comparableCurrentRate < previousNormalizedRate ? 'down' : 'flat';
      }

      const severityRank: Record<string, number> = { Critical: 4, High: 3, Medium: 2, Low: 1, Unclassified: 0 };
      const severity = matchingIncidents
        .map((incident) => incident.severity)
        .sort((left, right) => (severityRank[right] ?? -1) - (severityRank[left] ?? -1))[0] ?? null;
      const actions = new Map<string, number>();
      for (const incident of matchingIncidents) {
        const action = incident.recommended_action.trim();
        if (action) actions.set(action, (actions.get(action) ?? 0) + 1);
      }
      const recommendedAction = [...actions.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? null;

      return {
        category,
        issueVolume,
        normalizedRate,
        previousNormalizedRate,
        severity,
        affectedStores,
        quotes,
        owner,
        recommendedAction,
        trend,
      };
    })
      .filter((issue) => issue.issueVolume > 0)
      .sort((left, right) => (right.normalizedRate ?? -1) - (left.normalizedRate ?? -1) || right.issueVolume - left.issueVolume)
      .slice(0, 5);

    return {
      region,
      periodStart: latest.periodStart,
      periodEnd: latest.periodEnd,
      coveredStoreCount: coveredPeriods.length,
      expectedStoreCount: regionStores.length,
      topIssues,
    };
  });
}

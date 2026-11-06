import type { SupabaseClient } from '@supabase/supabase-js';

export type FeedbackDecision = {
  feedback_text: string;
  store_name: string | null;
  store_id: string | null;
  source: string;
  category: string;
  severity: string;
  actionability: 'actionable' | 'needs_review' | 'informational';
  recommended_department: string;
  recommended_action: string;
  explanation: string;
  status: string;
  requires_human_verification: boolean;
  escalation_required: boolean;
  classification_method: string;
};

export type Store = {
  id: string;
  store_code: string;
  name: string;
  region: string;
};

export type StoreMembership = {
  role: 'associate' | 'manager' | 'regional_manager';
  store: Store;
};

export type IncidentRecord = FeedbackDecision & {
  id: string;
  store_id: string;
  assigned_department: string;
  human_verified_at: string | null;
  human_verified_by: string | null;
  created_at: string;
  updated_at: string;
  store: Pick<Store, 'name' | 'region'> | null;
};

export type IncidentEvidence = {
  id: string;
  incident_id: string;
  source_record_id: string | null;
  feedback_text: string;
  source: string;
  received_at: string;
};

export type StoreWeeklyIssueRate = {
  store_id: string;
  region: string;
  period_start: string;
  period_end: string;
  category: string | null;
  issue_volume: number;
  evidence_volume: number;
  total_transactions: number;
  normalized_issue_rate: number | null;
  critical_issue_volume: number;
};

export type CreatedIncidentResponse = FeedbackDecision & {
  incident_id: string;
  assigned_department: string;
  human_verified_at: string | null;
  human_verified_by: string | null;
  created_at: string;
  updated_at: string;
};

export type AttachedIncidentEvidenceResponse = {
  evidence_id: string;
  incident_id: string;
  source: string;
  received_at: string;
};

export type IncidentStatus =
  | 'Open'
  | 'In Progress'
  | 'Resolved';

const incidentColumns = [
  'id',
  'store_id',
  'feedback_text',
  'source',
  'category',
  'severity',
  'actionability',
  'recommended_department',
  'assigned_department',
  'recommended_action',
  'explanation',
  'status',
  'requires_human_verification',
  'escalation_required',
  'human_verified_at',
  'human_verified_by',
  'classification_method',
  'created_at',
  'updated_at',
  'store:stores(name,region)',
].join(',');

const INCIDENT_PAGE_SIZE = 500;

function normalizeIncidentRecord(record: IncidentRecord): IncidentRecord {
  // The existing database check constraint stores this manager-facing state as
  // `In review`; the UI uses the requested operational label `In Progress`.
  return record.status === 'In review' ? { ...record, status: 'In Progress' } : record;
}

export async function loadStoreMemberships(client: SupabaseClient): Promise<StoreMembership[]> {
  const { data, error } = await client
    .from('store_memberships')
    .select('role, store:stores!inner(id,store_code,name,region)')
    .order('created_at', { ascending: true });

  if (error) throw error;
  return (data ?? []) as unknown as StoreMembership[];
}

export async function loadIncidents(
  client: SupabaseClient,
  since: string,
  until?: string,
): Promise<IncidentRecord[]> {
  const incidents: IncidentRecord[] = [];
  let offset = 0;

  // New incidents append to the end while paging, so an insert does not shift
  // rows already fetched. Reverse the complete result for newest-first display.
  while (true) {
    let request = client
      .from('incidents')
      .select(incidentColumns)
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (until) request = request.lt('created_at', until);
    const { data, error } = await request.range(offset, offset + INCIDENT_PAGE_SIZE - 1);

    if (error) throw error;
    const page = ((data ?? []) as unknown as IncidentRecord[]).map(normalizeIncidentRecord);
    incidents.push(...page);
    if (page.length < INCIDENT_PAGE_SIZE) return incidents.reverse();
    offset += page.length;
  }
}

export async function loadIncidentEvidenceForIncidents(
  client: SupabaseClient,
  incidentIds: string[],
): Promise<IncidentEvidence[]> {
  const rows: IncidentEvidence[] = [];
  const idBatchSize = 100;

  for (let idOffset = 0; idOffset < incidentIds.length; idOffset += idBatchSize) {
    const ids = incidentIds.slice(idOffset, idOffset + idBatchSize);
    let offset = 0;
    while (true) {
      const { data, error } = await client
        .from('incident_evidence')
        .select('id,incident_id,source_record_id,feedback_text,source,received_at')
        .in('incident_id', ids)
        .order('incident_id', { ascending: true })
        .order('received_at', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + INCIDENT_PAGE_SIZE - 1);

      if (error) throw error;
      const page = (data ?? []) as unknown as IncidentEvidence[];
      rows.push(...page);
      if (page.length < INCIDENT_PAGE_SIZE) break;
      offset += page.length;
    }
  }

  return rows;
}

export async function loadIncidentEvidenceForPeriod(
  client: SupabaseClient,
  periodStart: string,
  periodEnd: string,
): Promise<IncidentEvidence[]> {
  const rows: IncidentEvidence[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await client
      .from('incident_evidence')
      .select('id,incident_id,source_record_id,feedback_text,source,received_at')
      .gte('received_at', periodStart)
      .lt('received_at', periodEnd)
      .order('received_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + INCIDENT_PAGE_SIZE - 1);

    if (error) throw error;
    const page = (data ?? []) as unknown as IncidentEvidence[];
    rows.push(...page);
    if (page.length < INCIDENT_PAGE_SIZE) return rows;
    offset += page.length;
  }
}

export async function loadIncidentsByIds(
  client: SupabaseClient,
  incidentIds: string[],
): Promise<IncidentRecord[]> {
  const rows: IncidentRecord[] = [];
  const idBatchSize = 100;

  for (let idOffset = 0; idOffset < incidentIds.length; idOffset += idBatchSize) {
    const ids = incidentIds.slice(idOffset, idOffset + idBatchSize);
    let offset = 0;
    while (true) {
      const { data, error } = await client
        .from('incidents')
        .select(incidentColumns)
        .in('id', ids)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + INCIDENT_PAGE_SIZE - 1);

      if (error) throw error;
      const page = ((data ?? []) as unknown as IncidentRecord[]).map(normalizeIncidentRecord);
      rows.push(...page);
      if (page.length < INCIDENT_PAGE_SIZE) break;
      offset += page.length;
    }
  }

  return rows;
}

export async function loadStoreWeeklyIssueRates(
  client: SupabaseClient,
  since: string,
): Promise<StoreWeeklyIssueRate[]> {
  const rows: StoreWeeklyIssueRate[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await client
      .from('store_weekly_issue_rates')
      .select('store_id,region,period_start,period_end,category,issue_volume,evidence_volume,total_transactions,normalized_issue_rate,critical_issue_volume')
      .gte('period_start', since)
      .order('period_start', { ascending: true })
      .order('store_id', { ascending: true })
      .order('category', { ascending: true, nullsFirst: true })
      .range(offset, offset + INCIDENT_PAGE_SIZE - 1);

    if (error) throw error;
    const page = (data ?? []) as unknown as StoreWeeklyIssueRate[];
    rows.push(...page);
    if (page.length < INCIDENT_PAGE_SIZE) return rows;
    offset += page.length;
  }
}

export async function createIncident(
  apiBaseUrl: string,
  accessToken: string,
  storeId: string,
  feedbackText: string,
  source: string,
): Promise<CreatedIncidentResponse> {
  const normalizedApiBaseUrl = validateIncidentApiBaseUrl(apiBaseUrl);
  const response = await fetch(`${normalizedApiBaseUrl}/feedback/incidents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ feedback_text: feedbackText, store_id: storeId, source }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof payload === 'object' && payload !== null && 'detail' in payload
      ? String((payload as { detail: unknown }).detail)
      : `The API returned an error (${response.status}).`;
    throw new Error(detail);
  }
  if (!isCreatedIncidentResponse(payload)) {
    throw new Error('The API response had an unexpected incident format. Check that the backend is up to date.');
  }
  return payload;
}

export async function attachIncidentEvidence(
  apiBaseUrl: string,
  accessToken: string,
  incidentId: string,
  storeId: string,
  feedbackText: string,
  source: string,
): Promise<AttachedIncidentEvidenceResponse> {
  const normalizedApiBaseUrl = validateIncidentApiBaseUrl(apiBaseUrl);
  const response = await fetch(`${normalizedApiBaseUrl}/feedback/incidents/${encodeURIComponent(incidentId)}/evidence`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ store_id: storeId, feedback_text: feedbackText, source }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof payload === 'object' && payload !== null && 'detail' in payload
      ? String((payload as { detail: unknown }).detail)
      : `The API returned an error (${response.status}).`;
    throw new Error(detail);
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('The API response did not confirm that the evidence was attached.');
  }
  const result = payload as Record<string, unknown>;
  if (
    typeof result.evidence_id !== 'string' ||
    result.incident_id !== incidentId ||
    result.source !== source ||
    typeof result.received_at !== 'string'
  ) {
    throw new Error('The API response had an unexpected evidence format. Check that the backend is up to date.');
  }
  return result as AttachedIncidentEvidenceResponse;
}

function validateIncidentApiBaseUrl(apiBaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(apiBaseUrl.trim());
  } catch {
    throw new Error('The incident API URL is invalid.');
  }

  const hostname = parsed.hostname.toLowerCase();
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  const usesSecureTransport = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopback);
  if (!usesSecureTransport || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Incident submission requires HTTPS, except for local loopback development URLs.');
  }

  return apiBaseUrl.trim().replace(/\/+$/, '');
}

function isCreatedIncidentResponse(value: unknown): value is CreatedIncidentResponse {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.feedback_text === 'string' &&
    (result.store_name === null || typeof result.store_name === 'string') &&
    typeof result.store_id === 'string' &&
    typeof result.source === 'string' &&
    typeof result.category === 'string' &&
    typeof result.severity === 'string' &&
    (result.actionability === 'actionable' || result.actionability === 'needs_review' || result.actionability === 'informational') &&
    typeof result.recommended_department === 'string' &&
    typeof result.recommended_action === 'string' &&
    typeof result.explanation === 'string' &&
    typeof result.status === 'string' &&
    typeof result.requires_human_verification === 'boolean' &&
    typeof result.escalation_required === 'boolean' &&
    typeof result.classification_method === 'string' &&
    typeof result.incident_id === 'string' &&
    typeof result.assigned_department === 'string' &&
    (result.human_verified_at === null || typeof result.human_verified_at === 'string') &&
    (result.human_verified_by === null || typeof result.human_verified_by === 'string') &&
    typeof result.created_at === 'string' &&
    typeof result.updated_at === 'string'
  );
}

export async function updateIncident(
  client: SupabaseClient,
  incidentId: string,
  changes: { status?: IncidentStatus; assigned_department?: string; human_verified_at?: string },
): Promise<IncidentRecord> {
  const persistedChanges = changes.status === 'In Progress'
    ? { ...changes, status: 'In review' }
    : changes;
  const { data, error } = await client
    .from('incidents')
    .update(persistedChanges)
    .eq('id', incidentId)
    .select(incidentColumns)
    .single();

  if (error) throw error;
  return normalizeIncidentRecord(data as unknown as IncidentRecord);
}

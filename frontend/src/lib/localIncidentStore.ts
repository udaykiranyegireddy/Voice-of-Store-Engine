import type { FeedbackDecision, IncidentRecord, IncidentStatus } from './incidentService';

const STORAGE_KEY = 'voice-of-store.local-incidents.v1';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
export type IncidentDataView = 'demo' | 'local' | 'live';

export type LocalIncidentSnapshot = {
  records: IncidentRecord[];
  error: string;
};

export type LocalIncidentChanges = {
  status?: IncidentStatus;
  assigned_department?: string;
  human_verified_at?: string;
};

function browserStorage(): StorageLike {
  if (typeof window === 'undefined') {
    throw new Error('Browser storage is unavailable in this environment.');
  }
  try {
    return window.localStorage;
  } catch {
    throw new Error('Browser storage access is blocked.');
  }
}

function isIncidentRecord(value: unknown): value is IncidentRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<IncidentRecord>;
  return typeof record.id === 'string'
    && typeof record.store_id === 'string'
    && (record.store_name === null || typeof record.store_name === 'string')
    && typeof record.feedback_text === 'string'
    && typeof record.source === 'string'
    && typeof record.category === 'string'
    && typeof record.severity === 'string'
    && (record.actionability === 'actionable' || record.actionability === 'needs_review' || record.actionability === 'informational')
    && typeof record.assigned_department === 'string'
    && typeof record.recommended_department === 'string'
    && typeof record.recommended_action === 'string'
    && typeof record.explanation === 'string'
    && typeof record.status === 'string'
    && typeof record.requires_human_verification === 'boolean'
    && typeof record.escalation_required === 'boolean'
    && typeof record.classification_method === 'string'
    && (record.human_verified_at === null || typeof record.human_verified_at === 'string')
    && (record.human_verified_by === null || typeof record.human_verified_by === 'string')
    && typeof record.created_at === 'string'
    && typeof record.updated_at === 'string'
    && (record.store === null || (typeof record.store === 'object'
      && typeof record.store.name === 'string'
      && typeof record.store.region === 'string'));
}

function readRecords(storage: StorageLike): IncidentRecord[] {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return [];

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isIncidentRecord)) {
    throw new Error('Saved local incident data is unreadable; existing data was left untouched.');
  }
  return (parsed as IncidentRecord[]).map((record) => (
    record.status === 'In review' ? { ...record, status: 'In Progress' } : record
  ));
}

function newIncidentId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function loadLocalIncidentSnapshot(storage?: StorageLike): LocalIncidentSnapshot {
  try {
    return { records: readRecords(storage ?? browserStorage()), error: '' };
  } catch (error) {
    const message = error instanceof SyntaxError
      ? 'Saved local incident data is malformed; existing data was left untouched.'
      : error instanceof Error && error.message.includes('unreadable')
        ? error.message
        : 'Browser storage could not be read; existing local incidents were left untouched.';
    return {
      records: [],
      error: message,
    };
  }
}

export function initialDataView(snapshot: LocalIncidentSnapshot): IncidentDataView {
  return snapshot.records.length > 0 || snapshot.error ? 'local' : 'demo';
}

export function dataViewAfterAccountChange(currentView: IncidentDataView): IncidentDataView {
  return currentView === 'live' ? 'demo' : currentView;
}

export function saveLocalIncident(
  decision: FeedbackDecision,
  storeIdentifier: string,
  identifierType: 'name' | 'id',
  storage?: StorageLike,
  now = new Date(),
): IncidentRecord {
  const resolvedStorage = storage ?? browserStorage();
  const existing = readRecords(resolvedStorage);
  const normalizedStoreId = decision.store_id
    ?? `local-${storeIdentifier.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const displayName = decision.store_name || storeIdentifier.trim();
  const timestamp = now.toISOString();
  const record: IncidentRecord = {
    ...decision,
    store_name: identifierType === 'name' ? displayName : decision.store_name,
    store_id: normalizedStoreId,
    id: newIncidentId(),
    assigned_department: decision.recommended_department,
    human_verified_at: null,
    human_verified_by: null,
    created_at: timestamp,
    updated_at: timestamp,
    store: { name: displayName, region: 'Local browser' },
  };
  resolvedStorage.setItem(STORAGE_KEY, JSON.stringify([record, ...existing]));
  return record;
}

export function updateLocalIncident(
  incidentId: string,
  changes: LocalIncidentChanges,
  storage?: StorageLike,
  now = new Date(),
): IncidentRecord[] {
  const resolvedStorage = storage ?? browserStorage();
  const existing = readRecords(resolvedStorage);
  let found = false;
  const updated = existing.map((record) => {
    if (record.id !== incidentId) return record;
    found = true;
    return { ...record, ...changes, updated_at: now.toISOString() };
  });
  if (!found) throw new Error('The local incident was not found.');
  resolvedStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  return updated;
}

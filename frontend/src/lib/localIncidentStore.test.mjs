import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dataViewAfterAccountChange,
  initialDataView,
  loadLocalIncidentSnapshot,
  saveLocalIncident,
  updateLocalIncident,
} from './localIncidentStore.ts';

function createMemoryStorage(initial = null) {
  let value = initial;
  return {
    getItem(key) {
      assert.equal(key, 'voice-of-store.local-incidents.v1');
      return value;
    },
    setItem(key, nextValue) {
      assert.equal(key, 'voice-of-store.local-incidents.v1');
      value = nextValue;
    },
    value() {
      return value;
    },
  };
}

const decision = {
  feedback_text: 'The freezer is broken and ice cream is melting.',
  store_name: 'Demo Store 12',
  store_id: null,
  source: 'customer_feedback',
  category: 'Equipment failure',
  severity: 'High',
  actionability: 'actionable',
  recommended_department: 'Facilities & Maintenance',
  recommended_action: 'Have Facilities & Maintenance inspect the freezer.',
  explanation: 'Matched the freezer keyword.',
  status: 'Open',
  requires_human_verification: false,
  escalation_required: false,
  classification_method: 'transparent_rules',
};

test('a fresh app load recovers saved incidents and selects the local view', () => {
  const storage = createMemoryStorage();
  const createdAt = new Date('2026-10-29T10:00:00.000Z');
  const saved = saveLocalIncident(decision, 'Demo Store 12', 'name', storage, createdAt);
  const reloadedStorage = createMemoryStorage(storage.value());
  const loaded = loadLocalIncidentSnapshot(reloadedStorage);

  assert.equal(loaded.error, '');
  assert.equal(loaded.records.length, 1);
  assert.equal(loaded.records[0].id, saved.id);
  assert.equal(loaded.records[0].feedback_text, decision.feedback_text);
  assert.equal(loaded.records[0].assigned_department, 'Facilities & Maintenance');
  assert.equal(loaded.records[0].store?.region, 'Local browser');
  assert.equal(initialDataView(loaded), 'local');
  assert.equal(initialDataView({ records: [], error: '' }), 'demo');
});

test('account view resets preserve local incidents in browser storage', () => {
  const storage = createMemoryStorage();
  const saved = saveLocalIncident(decision, 'Demo Store 12', 'name', storage);

  assert.equal(dataViewAfterAccountChange('demo'), 'demo');
  assert.equal(dataViewAfterAccountChange('live'), 'demo');
  assert.equal(dataViewAfterAccountChange('local'), 'local');
  assert.equal(loadLocalIncidentSnapshot(storage).records[0].id, saved.id);
});

test('updates the local assigned team, operational status, and human review timestamp', () => {
  const storage = createMemoryStorage();
  const saved = saveLocalIncident(decision, 'Demo Store 12', 'name', storage);
  const reviewedAt = '2026-10-29T10:05:00.000Z';
  const updated = updateLocalIncident(saved.id, {
    assigned_department: 'Facilities Desk',
    status: 'In Progress',
    human_verified_at: reviewedAt,
  }, storage, new Date(reviewedAt));

  assert.equal(updated[0].assigned_department, 'Facilities Desk');
  assert.equal(updated[0].status, 'In Progress');
  assert.equal(updated[0].human_verified_at, reviewedAt);
  assert.equal(loadLocalIncidentSnapshot(storage).records[0].updated_at, reviewedAt);
});

test('normalizes previously saved In review statuses for the current dashboard', () => {
  const storage = createMemoryStorage();
  const saved = saveLocalIncident(decision, 'Demo Store 12', 'name', storage);
  storage.setItem('voice-of-store.local-incidents.v1', JSON.stringify([{ ...saved, status: 'In review' }]));

  const snapshot = loadLocalIncidentSnapshot(storage);
  assert.equal(snapshot.records[0].status, 'In Progress');
  assert.equal(JSON.parse(storage.value())[0].status, 'In review');
});

test('does not overwrite malformed existing local incident data', () => {
  const storage = createMemoryStorage('{invalid json');
  const snapshot = loadLocalIncidentSnapshot(storage);

  assert.match(snapshot.error, /malformed.*left untouched/i);
  assert.throws(() => saveLocalIncident(decision, 'Demo Store 12', 'name', storage), /JSON/);
  assert.equal(storage.value(), '{invalid json');
});

test('reports storage read failures without attempting a write', () => {
  const storage = {
    getItem() { throw new Error('storage denied'); },
    setItem() { assert.fail('A read failure must not trigger a write.'); },
  };
  const snapshot = loadLocalIncidentSnapshot(storage);

  assert.equal(snapshot.records.length, 0);
  assert.match(snapshot.error, /could not be read.*left untouched/i);
  assert.equal(initialDataView(snapshot), 'local');
});

test('reports when the browser blocks access to localStorage', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const blockedWindow = Object.defineProperty({}, 'localStorage', {
    get() { throw new Error('access denied'); },
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: blockedWindow });

  try {
    const snapshot = loadLocalIncidentSnapshot();
    assert.match(snapshot.error, /could not be read.*left untouched/i);
    assert.equal(initialDataView(snapshot), 'local');
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete globalThis.window;
  }
});

test('reports browser storage write failures to its caller', () => {
  const storage = {
    getItem() { return null; },
    setItem() { throw new Error('quota exceeded'); },
  };

  assert.throws(
    () => saveLocalIncident(decision, 'Demo Store 12', 'name', storage),
    /quota exceeded/,
  );
});

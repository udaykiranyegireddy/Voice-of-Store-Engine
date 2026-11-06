import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createIncident,
  loadIncidentEvidenceForIncidents,
  loadIncidentEvidenceForPeriod,
  loadIncidents,
  loadIncidentsByIds,
  loadStoreWeeklyIssueRates,
  updateIncident,
} from './incidentService.ts';

const validResponse = {
  feedback_text: 'The freezer is broken.',
  store_name: 'Store 12',
  store_id: 'aa4a5374-dca3-472e-b345-427ec022ab3e',
  source: 'staff_report',
  category: 'Equipment failure',
  severity: 'High',
  actionability: 'actionable',
  recommended_department: 'Facilities & Maintenance',
  recommended_action: 'Have Facilities & Maintenance inspect the freezer.',
  explanation: 'Matched the equipment-failure keyword.',
  status: 'Open',
  requires_human_verification: false,
  escalation_required: false,
  human_verified_at: null,
  human_verified_by: null,
  classification_method: 'transparent_rules',
  incident_id: 'cc46292c-ae0a-4bfe-b84b-272f4ea01ff2',
  assigned_department: 'Facilities & Maintenance',
  created_at: '2026-10-28T10:00:00+00:00',
  updated_at: '2026-10-28T10:00:00+00:00',
};

test('createIncident sends an authenticated request with only user feedback fields', async () => {
  const originalFetch = globalThis.fetch;
  let capturedRequest;
  globalThis.fetch = async (url, init) => {
    capturedRequest = { url, init };
    return { ok: true, status: 201, json: async () => validResponse };
  };

  try {
    const result = await createIncident(
      'http://127.0.0.1:8000/',
      'signed-in-user-token',
      validResponse.store_id,
      validResponse.feedback_text,
      validResponse.source,
    );

    assert.equal(capturedRequest.url, 'http://127.0.0.1:8000/feedback/incidents');
    assert.equal(capturedRequest.init.method, 'POST');
    assert.equal(capturedRequest.init.headers.Authorization, 'Bearer signed-in-user-token');
    assert.deepEqual(JSON.parse(capturedRequest.init.body), {
      feedback_text: validResponse.feedback_text,
      store_id: validResponse.store_id,
      source: validResponse.source,
    });
    assert.equal(result.assigned_department, 'Facilities & Maintenance');
    assert.equal(result.category, 'Equipment failure');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createIncident exposes safe API error details to the form', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ detail: 'Your account is not authorized for this store.' }),
  });

  try {
    await assert.rejects(
      createIncident('http://127.0.0.1:8000', 'signed-in-user-token', validResponse.store_id, 'Feedback', 'staff_report'),
      { message: 'Your account is not authorized for this store.' },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createIncident never sends a bearer token to a remote HTTP API', async () => {
  const originalFetch = globalThis.fetch;
  let requestWasSent = false;
  globalThis.fetch = async () => {
    requestWasSent = true;
    return { ok: true, status: 201, json: async () => validResponse };
  };

  try {
    await assert.rejects(
      createIncident('http://api.example.test', 'signed-in-user-token', validResponse.store_id, 'Feedback', 'staff_report'),
      /requires HTTPS/i,
    );
    assert.equal(requestWasSent, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createIncident rejects an incomplete or unknown response shape', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 201,
    json: async () => ({ ...validResponse, actionability: 'unknown-value' }),
  });

  try {
    await assert.rejects(
      createIncident('http://127.0.0.1:8000', 'signed-in-user-token', validResponse.store_id, 'Feedback', 'staff_report'),
      /unexpected incident format/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('updateIncident maps In Progress to the existing database status and returns audit fields', async () => {
  let changesSent;
  const row = {
    ...validResponse,
    id: 'incident-id',
    status: 'In review',
    human_verified_at: '2026-10-28T10:05:00+00:00',
    human_verified_by: 'b34d01d0-954c-48be-a712-a97ab8913785',
    store: { name: 'Store 12', region: 'North' },
  };
  const client = {
    from(table) {
      assert.equal(table, 'incidents');
      return {
        update(changes) { changesSent = changes; return this; },
        eq(column, value) { assert.equal(column, 'id'); assert.equal(value, 'incident-id'); return this; },
        select(columns) { assert.match(columns, /human_verified_at/); assert.match(columns, /human_verified_by/); return this; },
        single() { return Promise.resolve({ data: row, error: null }); },
      };
    },
  };

  const updated = await updateIncident(client, 'incident-id', {
    status: 'In Progress',
    assigned_department: 'Merchandising',
    human_verified_at: 'client-requested-time',
  });

  assert.deepEqual(changesSent, {
    status: 'In review',
    assigned_department: 'Merchandising',
    human_verified_at: 'client-requested-time',
  });
  assert.equal(updated.status, 'In Progress');
  assert.equal(updated.human_verified_by, row.human_verified_by);
  assert.equal(updated.human_verified_at, row.human_verified_at);
});

test('loadIncidents presents existing In review rows as In Progress', async () => {
  const client = {
    from(table) {
      assert.equal(table, 'incidents');
      return {
        select() { return this; },
        gte() { return this; },
        order() { return this; },
        range() {
          return Promise.resolve({ data: [{ ...validResponse, id: 'incident-id', status: 'In review' }], error: null });
        },
      };
    },
  };

  const incidents = await loadIncidents(client, '2026-10-14T10:00:00.000Z');
  assert.equal(incidents[0].status, 'In Progress');
});

test('loadIncidents paginates all authorized rows with stable ordering', async () => {
  const firstPage = Array.from({ length: 500 }, (_, index) => ({ id: `incident-${index}` }));
  const secondPage = Array.from({ length: 500 }, (_, index) => ({ id: `incident-${index + 500}` }));
  const lastPage = [{ id: 'incident-1000' }];
  const pages = new Map([[0, firstPage], [500, secondPage], [1000, lastPage]]);
  const ranges = [];
  const ordering = [];

  const client = {
    from(table) {
      assert.equal(table, 'incidents');
      return {
        select() { return this; },
        gte(column, value) {
          assert.equal(column, 'created_at');
          assert.equal(value, '2026-10-14T10:00:00.000Z');
          return this;
        },
        order(column, options) {
          ordering.push([column, options.ascending]);
          return this;
        },
        range(start, end) {
          ranges.push([start, end]);
          return Promise.resolve({ data: pages.get(start) ?? [], error: null });
        },
      };
    },
  };

  const incidents = await loadIncidents(client, '2026-10-14T10:00:00.000Z');

  assert.equal(incidents.length, 1001);
  assert.deepEqual(ranges, [[0, 499], [500, 999], [1000, 1499]]);
  assert.deepEqual(ordering, Array(3).fill([['created_at', true], ['id', true]]).flat());
  assert.equal(incidents.at(0).id, 'incident-1000');
  assert.equal(incidents.at(-1).id, 'incident-0');
});

test('loadStoreWeeklyIssueRates reads only the authorized view and requests stable pages', async () => {
  const ranges = [];
  const filters = [];
  const ordering = [];
  const client = {
    from(table) {
      assert.equal(table, 'store_weekly_issue_rates');
      return {
        select(columns) { assert.match(columns, /normalized_issue_rate/); return this; },
        gte(column, value) { filters.push([column, value]); return this; },
        order(column, options) { ordering.push([column, options]); return this; },
        range(start, end) {
          ranges.push([start, end]);
          return Promise.resolve({ data: [{ store_id: 'store-1', issue_volume: 1 }], error: null });
        },
      };
    },
  };

  const rows = await loadStoreWeeklyIssueRates(client, '2026-08-01T00:00:00.000Z');
  assert.equal(rows.length, 1);
  assert.deepEqual(filters, [['period_start', '2026-08-01T00:00:00.000Z']]);
  assert.deepEqual(ranges, [[0, 499]]);
  assert.deepEqual(ordering.map(([column]) => column), ['period_start', 'store_id', 'category']);
});

test('loadIncidentEvidenceForIncidents chunks incident IDs and reads linked source quotes', async () => {
  const ids = Array.from({ length: 101 }, (_, index) => `incident-${index}`);
  const batches = [];
  const client = {
    from(table) {
      assert.equal(table, 'incident_evidence');
      return {
        select(columns) { assert.match(columns, /feedback_text/); return this; },
        in(column, values) { assert.equal(column, 'incident_id'); batches.push(values); return this; },
        order() { return this; },
        range() { return Promise.resolve({ data: [], error: null }); },
      };
    },
  };

  const evidence = await loadIncidentEvidenceForIncidents(client, ids);
  assert.deepEqual(evidence, []);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 100);
  assert.equal(batches[1].length, 1);
});

test('report loaders bind evidence to source time and fetch parent incident records by ID', async () => {
  const evidenceFilters = [];
  const evidenceClient = {
    from(table) {
      assert.equal(table, 'incident_evidence');
      return {
        select() { return this; },
        gte(column, value) { evidenceFilters.push([column, value]); return this; },
        lt(column, value) { evidenceFilters.push([column, value]); return this; },
        order() { return this; },
        range() { return Promise.resolve({ data: [{ id: 'evidence-1', incident_id: 'incident-1' }], error: null }); },
      };
    },
  };
  const sourceEvidence = await loadIncidentEvidenceForPeriod(
    evidenceClient,
    '2026-10-14T00:00:00.000Z',
    '2026-10-21T00:00:00.000Z',
  );
  assert.equal(sourceEvidence[0].incident_id, 'incident-1');
  assert.deepEqual(evidenceFilters, [
    ['received_at', '2026-10-14T00:00:00.000Z'],
    ['received_at', '2026-10-21T00:00:00.000Z'],
  ]);

  let selectedIds;
  const incidentClient = {
    from(table) {
      assert.equal(table, 'incidents');
      return {
        select() { return this; },
        in(column, value) { assert.equal(column, 'id'); selectedIds = value; return this; },
        order() { return this; },
        range() { return Promise.resolve({ data: [{ id: 'incident-1' }], error: null }); },
      };
    },
  };
  const parents = await loadIncidentsByIds(incidentClient, ['incident-1']);
  assert.deepEqual(selectedIds, ['incident-1']);
  assert.equal(parents[0].id, 'incident-1');
});

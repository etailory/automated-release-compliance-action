/**
 * Governor OS Web Server — integration tests
 *
 * Uses Node.js built-in node:test and native fetch (Node 18+). No external
 * test dependencies required.
 *
 * Run with: npm test (or: node --test server.test.js)
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { app, auditJobs, validateLicenseKey } from './server.js';

// ---------------------------------------------------------------------------
// Test server lifecycle — bind to a random port so tests never conflict
// ---------------------------------------------------------------------------

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(() => {
  // Reset job store between tests for isolation
  auditJobs.clear();
  // Ensure LICENSE_SECRET is unset by default so tests work in dev mode
  delete process.env.LICENSE_SECRET;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function req(method, path, body, headers = {}) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res  = await fetch(`${baseUrl}${path}`, opts);
  const json = await res.json();
  return { status: res.status, body: json };
}

const VALID_AUDIT_PAYLOAD = {
  schemaVersion: '1.0',
  repository:    'acme/widgets',
  release: {
    tag:          'v1.2.0',
    name:         'Spring Release',
    isPrerelease: false,
    isDraft:      false,
    publishedAt:  '2026-05-31T00:00:00Z',
    author:       'octocat',
  },
  requested: {
    isoControlMapping: true,
    evidencePdf:       true,
    governanceVerdict: true,
  },
};

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  test('returns 200 with ok status', async () => {
    const { status, body } = await req('GET', '/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'governor-os-web');
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/compliance/audit — authentication
// ---------------------------------------------------------------------------

describe('POST /api/v1/compliance/audit — auth', () => {
  test('returns 401 when Authorization header is absent', async () => {
    const { status, body } = await req('POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD);
    assert.equal(status, 401);
    assert.equal(body.success, false);
  });

  test('returns 401 when Bearer token is empty string', async () => {
    const { status, body } = await req(
      'POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD,
      { Authorization: 'Bearer ' }
    );
    assert.equal(status, 401);
    assert.equal(body.success, false);
  });

  test('returns 401 when LICENSE_SECRET is set and key does not match', async () => {
    process.env.LICENSE_SECRET = 'correct-secret';
    const { status, body } = await req(
      'POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD,
      { Authorization: 'Bearer wrong-secret-xx' }
    );
    assert.equal(status, 401);
    assert.equal(body.success, false);
    delete process.env.LICENSE_SECRET;
  });

  test('accepts request when LICENSE_SECRET is set and key matches', async () => {
    process.env.LICENSE_SECRET = 'my-license-key';
    const { status } = await req(
      'POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD,
      { Authorization: 'Bearer my-license-key' }
    );
    assert.equal(status, 202);
    delete process.env.LICENSE_SECRET;
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/compliance/audit — input validation
// ---------------------------------------------------------------------------

describe('POST /api/v1/compliance/audit — validation', () => {
  const AUTH = { Authorization: 'Bearer test-key' };

  test('returns 400 when schemaVersion is missing', async () => {
    const payload = { repository: 'acme/widgets', release: { tag: 'v1.0.0' } };
    const { status, body } = await req('POST', '/api/v1/compliance/audit', payload, AUTH);
    assert.equal(status, 400);
    assert.match(body.error, /schemaVersion/);
  });

  test('returns 400 when repository is missing', async () => {
    const payload = { schemaVersion: '1.0', release: { tag: 'v1.0.0' } };
    const { status, body } = await req('POST', '/api/v1/compliance/audit', payload, AUTH);
    assert.equal(status, 400);
    assert.match(body.error, /repository/);
  });

  test('returns 400 when release.tag is missing', async () => {
    const payload = { schemaVersion: '1.0', repository: 'acme/widgets', release: { name: 'GA' } };
    const { status, body } = await req('POST', '/api/v1/compliance/audit', payload, AUTH);
    assert.equal(status, 400);
    assert.match(body.error, /release\.tag/);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/compliance/audit — happy path
// ---------------------------------------------------------------------------

describe('POST /api/v1/compliance/audit — success', () => {
  const AUTH = { Authorization: 'Bearer test-key' };

  test('returns 202 with a jobId', async () => {
    const { status, body } = await req('POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD, AUTH);
    assert.equal(status, 202);
    assert.equal(body.success, true);
    assert.equal(typeof body.jobId, 'string');
    assert.ok(body.jobId.startsWith('audit-'));
  });

  test('stores the job in the in-memory store', async () => {
    const { body } = await req('POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD, AUTH);
    assert.ok(auditJobs.has(body.jobId));
    const job = auditJobs.get(body.jobId);
    assert.equal(job.status, 'complete');
    assert.equal(job.repository, 'acme/widgets');
    assert.equal(job.tag, 'v1.2.0');
  });

  test('processes job synchronously — status is complete immediately', async () => {
    const { body: post } = await req('POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD, AUTH);
    const job = auditJobs.get(post.jobId);
    assert.equal(job.status, 'complete');
    assert.ok(job.completedAt);
  });

  test('includes governanceVerdict in the result', async () => {
    const { body: post } = await req('POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD, AUTH);
    const job = auditJobs.get(post.jobId);
    assert.equal(job.result.governanceVerdict.verdict, 'approved');
  });

  test('verdict is conditional for a pre-release', async () => {
    const payload = {
      ...VALID_AUDIT_PAYLOAD,
      release: { ...VALID_AUDIT_PAYLOAD.release, isPrerelease: true },
    };
    const { body: post } = await req('POST', '/api/v1/compliance/audit', payload, AUTH);
    const job = auditJobs.get(post.jobId);
    assert.equal(job.result.governanceVerdict.verdict, 'conditional');
  });

  test('verdict is blocked for a draft release', async () => {
    const payload = {
      ...VALID_AUDIT_PAYLOAD,
      release: { ...VALID_AUDIT_PAYLOAD.release, isDraft: true },
    };
    const { body: post } = await req('POST', '/api/v1/compliance/audit', payload, AUTH);
    const job = auditJobs.get(post.jobId);
    assert.equal(job.result.governanceVerdict.verdict, 'blocked');
  });

  test('includes isoControlMapping when requested', async () => {
    const { body: post } = await req('POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD, AUTH);
    const job = auditJobs.get(post.jobId);
    assert.ok(job.result.isoControlMapping);
    assert.ok(job.result.isoControlMapping['CC6.1']);
  });

  test('omits isoControlMapping when not requested', async () => {
    const payload = {
      ...VALID_AUDIT_PAYLOAD,
      requested: { ...VALID_AUDIT_PAYLOAD.requested, isoControlMapping: false },
    };
    const { body: post } = await req('POST', '/api/v1/compliance/audit', payload, AUTH);
    const job = auditJobs.get(post.jobId);
    assert.equal(job.result.isoControlMapping, undefined);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/compliance/audit/:jobId
// ---------------------------------------------------------------------------

describe('GET /api/v1/compliance/audit/:jobId', () => {
  const AUTH = { Authorization: 'Bearer test-key' };

  test('returns 404 for an unknown jobId', async () => {
    const { status, body } = await req('GET', '/api/v1/compliance/audit/nonexistent-job-id');
    assert.equal(status, 404);
    assert.equal(body.success, false);
  });

  test('returns 200 with complete status for a processed job', async () => {
    const { body: post } = await req('POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD, AUTH);
    const { status, body } = await req('GET', `/api/v1/compliance/audit/${post.jobId}`);
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.status, 'complete');
    assert.equal(body.jobId, post.jobId);
  });

  test('response includes the audit result', async () => {
    const { body: post } = await req('POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD, AUTH);
    const { body } = await req('GET', `/api/v1/compliance/audit/${post.jobId}`);
    assert.ok(body.result);
    assert.equal(body.result.repository, 'acme/widgets');
    assert.equal(body.result.release.tag, 'v1.2.0');
    assert.equal(body.result.governanceVerdict.verdict, 'approved');
  });

  test('message describes completion', async () => {
    const { body: post } = await req('POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD, AUTH);
    const { body } = await req('GET', `/api/v1/compliance/audit/${post.jobId}`);
    assert.match(body.message, /Audit complete/);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/compliance/verify
// ---------------------------------------------------------------------------

describe('POST /api/v1/compliance/verify', () => {
  test('returns 400 when required fields are missing', async () => {
    const { status, body } = await req('POST', '/api/v1/compliance/verify', {
      oidcToken: 'tok',
      organizationId: 'org-1',
      // missing serviceAccountId and federationRuleId
    });
    assert.equal(status, 400);
    assert.equal(body.success, false);
  });

  test('returns 200 with session token when all fields are present', async () => {
    const { status, body } = await req('POST', '/api/v1/compliance/verify', {
      oidcToken:        'fake-jwt-token',
      organizationId:   'acme-corp',
      serviceAccountId: 'ci-service',
      federationRuleId: 'rule-1',
    });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.ok(body.sessionToken);
    assert.ok(body.expiresIn > 0);
  });
});

// ---------------------------------------------------------------------------
// 404 fallback
// ---------------------------------------------------------------------------

describe('404 fallback', () => {
  test('returns 404 for unknown routes', async () => {
    const { status, body } = await req('GET', '/api/v1/nonexistent');
    assert.equal(status, 404);
    assert.ok(body.error);
  });
});

// ---------------------------------------------------------------------------
// validateLicenseKey (unit tests — no HTTP)
// ---------------------------------------------------------------------------

describe('validateLicenseKey', () => {
  test('returns true when LICENSE_SECRET is unset (dev mode)', () => {
    delete process.env.LICENSE_SECRET;
    assert.equal(validateLicenseKey('any-key'), true);
  });

  test('returns true when key matches LICENSE_SECRET exactly', () => {
    process.env.LICENSE_SECRET = 'secret-abc';
    assert.equal(validateLicenseKey('secret-abc'), true);
    delete process.env.LICENSE_SECRET;
  });

  test('returns false when key does not match LICENSE_SECRET', () => {
    process.env.LICENSE_SECRET = 'secret-abc';
    assert.equal(validateLicenseKey('wrong-key'), false);
    delete process.env.LICENSE_SECRET;
  });

  test('returns false when key length differs from LICENSE_SECRET', () => {
    process.env.LICENSE_SECRET = 'short';
    assert.equal(validateLicenseKey('a-much-longer-key-that-does-not-match'), false);
    delete process.env.LICENSE_SECRET;
  });
});

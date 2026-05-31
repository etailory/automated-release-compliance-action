/**
 * Governor OS Web Server — integration tests
 *
 * Uses Node.js built-in node:test and native fetch (Node 18+). No external
 * test dependencies required beyond jose (already in package.json).
 *
 * Run with: npm test (or: node --test server.test.js)
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import {
  app,
  auditJobs,
  evictedJobIds,
  orgRegistry,
  validateLicenseKey,
  _auditLimiterStore,
  _verifyLimiterStore,
  _resetJwksCache,
  _loadOrgsFromFile,
  _flushOrgsToFile,
  _loadOrgsFromEnv,
} from './server.js';

// ---------------------------------------------------------------------------
// Test server lifecycle — bind to a random port so tests never conflict
// ---------------------------------------------------------------------------

let server;
let baseUrl;

// Shared temp directory for all test file I/O — cleaned up in after()
let testDataDir;
let testFileCounter = 0;

// OIDC test state — populated in before()
let testPrivateKey;       // RSA private key for signing test JWTs
let testPublicJwk;        // Corresponding public JWK served by mock JWKS server
let wrongPrivateKey;      // A different RSA key — used to simulate invalid signatures
let mockJwksServer;       // HTTP server that serves testPublicJwk as a JWKS
let mockJwksPort;
let mockJwksMode = 'ok';  // 'ok' | 'error' — controls mock server response

before(async () => {
  // Create a shared temp directory for file persistence tests
  testDataDir = await mkdtemp(join(tmpdir(), 'govos-test-'));

  // Start the app server
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // Generate RSA key pair for test JWTs
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  testPrivateKey = privateKey;
  const rawJwk = await exportJWK(publicKey);
  testPublicJwk = { ...rawJwk, kid: 'test-key-1', use: 'sig', alg: 'RS256' };

  // Generate a second key pair — used to produce JWTs with invalid signatures
  ({ privateKey: wrongPrivateKey } = await generateKeyPair('RS256'));

  // Start mock JWKS server
  await new Promise((resolve) => {
    mockJwksServer = createServer((req, res) => {
      if (req.url === '/.well-known/jwks') {
        if (mockJwksMode === 'error') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ keys: [testPublicJwk] }));
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    mockJwksServer.listen(0, '127.0.0.1', () => {
      mockJwksPort = mockJwksServer.address().port;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await new Promise((resolve, reject) => {
    mockJwksServer.close((err) => (err ? reject(err) : resolve()));
  });
  await rm(testDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Reset job store and eviction tracking between tests for isolation
  auditJobs.clear();
  evictedJobIds.clear();
  // Clear org registry so each test starts in dev mode (permissive)
  orgRegistry.clear();
  // Reset rate limiter counters so tests don't bleed into each other
  await _auditLimiterStore.resetAll?.();
  await _verifyLimiterStore.resetAll?.();
  // Ensure sensitive env vars are unset by default
  delete process.env.LICENSE_SECRET;
  delete process.env.ADMIN_SECRET;
  delete process.env.ORGS_CONFIG;
  // Point file persistence to isolated per-test paths under the shared temp dir
  const id = ++testFileCounter;
  process.env.ORGS_FILE      = join(testDataDir, `orgs-${id}.json`);
  process.env.AUDIT_LOG_FILE = join(testDataDir, `audit-log-${id}.ndjson`);
  // Set OIDC env vars and reset JWKS cache for every test
  process.env.JWKS_URL      = `http://127.0.0.1:${mockJwksPort}/.well-known/jwks`;
  process.env.OIDC_ISSUER   = 'https://token.actions.githubusercontent.com';
  process.env.OIDC_AUDIENCE = 'governor-os';
  process.env.SESSION_SECRET = 'test-session-secret-exactly-32bytes';
  mockJwksMode = 'ok';
  _resetJwksCache();
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

/**
 * Mint a GitHub Actions-style OIDC JWT using the test RSA private key.
 * All fields default to valid values; pass overrides to test failure paths.
 */
async function mintOidcJwt({
  sub        = 'repo:owner/repo:ref:refs/heads/main',
  iss        = 'https://token.actions.githubusercontent.com',
  aud        = 'governor-os',
  expiresIn  = '5m',
  signingKey = null, // defaults to testPrivateKey — set after before() runs
  kid        = 'test-key-1',
} = {}) {
  const key = signingKey ?? testPrivateKey;
  return new SignJWT({ sub })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

const VALID_VERIFY_BODY = {
  organizationId:   'acme-corp',
  serviceAccountId: 'ci-service',
  federationRuleId: 'repo:owner/repo',
};

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

  test('accepts request when bearer token is a valid session token', async () => {
    // Obtain a session token via the verify endpoint
    const oidcToken = await mintOidcJwt();
    const { body: vBody } = await req('POST', '/api/v1/compliance/verify', {
      ...VALID_VERIFY_BODY,
      oidcToken,
    });
    assert.equal(vBody.success, true, 'Expected verify to succeed');

    // Use the session token to authenticate an audit request
    const { status } = await req(
      'POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD,
      { Authorization: `Bearer ${vBody.sessionToken}` }
    );
    assert.equal(status, 202);
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
// POST /api/v1/compliance/verify — input validation
// ---------------------------------------------------------------------------

describe('POST /api/v1/compliance/verify — validation', () => {
  test('returns 400 when required fields are missing', async () => {
    const { status, body } = await req('POST', '/api/v1/compliance/verify', {
      oidcToken: 'tok',
      organizationId: 'org-1',
      // missing serviceAccountId and federationRuleId
    });
    assert.equal(status, 400);
    assert.equal(body.success, false);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/compliance/verify — OIDC verification
// ---------------------------------------------------------------------------

describe('POST /api/v1/compliance/verify — OIDC', () => {
  test('returns 200 with a signed session token for a valid OIDC JWT', async () => {
    const oidcToken = await mintOidcJwt();
    const { status, body } = await req('POST', '/api/v1/compliance/verify', {
      ...VALID_VERIFY_BODY,
      oidcToken,
    });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.ok(body.sessionToken, 'Expected sessionToken in response');
    // Session token must be a JWT (three dot-separated parts)
    assert.equal(body.sessionToken.split('.').length, 3);
    assert.equal(body.expiresIn, 3600);
    assert.ok(body.message);
  });

  test('returns 401 when OIDC JWT has an invalid signature', async () => {
    // Sign with wrongPrivateKey — not in the mock JWKS
    const oidcToken = await mintOidcJwt({ signingKey: wrongPrivateKey });
    const { status, body } = await req('POST', '/api/v1/compliance/verify', {
      ...VALID_VERIFY_BODY,
      oidcToken,
    });
    assert.equal(status, 401);
    assert.equal(body.success, false);
  });

  test('returns 401 for an expired OIDC JWT', async () => {
    // Issue a token that expired in the past (-1s from now)
    const oidcToken = await mintOidcJwt({ expiresIn: '-1s' });
    const { status, body } = await req('POST', '/api/v1/compliance/verify', {
      ...VALID_VERIFY_BODY,
      oidcToken,
    });
    assert.equal(status, 401);
    assert.equal(body.success, false);
  });

  test('returns 401 when iss does not match', async () => {
    const oidcToken = await mintOidcJwt({ iss: 'https://evil.example.com' });
    const { status, body } = await req('POST', '/api/v1/compliance/verify', {
      ...VALID_VERIFY_BODY,
      oidcToken,
    });
    assert.equal(status, 401);
    assert.equal(body.success, false);
  });

  test('returns 401 when aud does not match', async () => {
    const oidcToken = await mintOidcJwt({ aud: 'wrong-audience' });
    const { status, body } = await req('POST', '/api/v1/compliance/verify', {
      ...VALID_VERIFY_BODY,
      oidcToken,
    });
    assert.equal(status, 401);
    assert.equal(body.success, false);
  });

  test('returns 401 when sub does not match federationRuleId', async () => {
    // sub starts with 'repo:other/repo' but federationRuleId expects 'repo:owner/repo'
    const oidcToken = await mintOidcJwt({ sub: 'repo:other/repo:ref:refs/heads/main' });
    const { status, body } = await req('POST', '/api/v1/compliance/verify', {
      ...VALID_VERIFY_BODY,
      oidcToken,
      federationRuleId: 'repo:owner/repo',
    });
    assert.equal(status, 401);
    assert.equal(body.success, false);
  });

  test('returns 503 when JWKS endpoint is unreachable', async () => {
    mockJwksMode = 'error';
    _resetJwksCache();
    const oidcToken = await mintOidcJwt();
    const { status, body } = await req('POST', '/api/v1/compliance/verify', {
      ...VALID_VERIFY_BODY,
      oidcToken,
    });
    assert.equal(status, 503);
    assert.equal(body.success, false);
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
// Rate limiting
// ---------------------------------------------------------------------------

describe('POST /api/v1/compliance/audit — rate limiting', () => {
  const AUTH = { Authorization: 'Bearer test-key' };

  test('returns 429 after exceeding 30 requests per minute', async () => {
    // Send 31 parallel requests; at least one must be rejected
    const responses = await Promise.all(
      Array.from({ length: 31 }, () =>
        req('POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD, AUTH)
      )
    );
    const tooMany = responses.filter(r => r.status === 429);
    assert.ok(tooMany.length >= 1, 'Expected at least one 429 response');
    assert.equal(tooMany[0].body.success, false);
    assert.match(tooMany[0].body.error, /Too many/);
  });
});

// ---------------------------------------------------------------------------
// TTL eviction + 410 Gone
// ---------------------------------------------------------------------------

describe('TTL eviction and 410 Gone', () => {
  const AUTH = { Authorization: 'Bearer test-key' };

  test('evicts expired jobs on the next write and returns 410 Gone', async () => {
    // Inject an already-expired job directly into the store
    const expiredId = 'audit-expired-test-job';
    auditJobs.set(expiredId, {
      status:      'complete',
      submittedAt: new Date(Date.now() - 25 * 3_600_000).toISOString(),
      completedAt: new Date(Date.now() - 25 * 3_600_000).toISOString(),
      repository:  'acme/widgets',
      tag:         'v0.0.1',
      expiresAt:   Date.now() - 1000, // already past TTL
      result:      {},
    });

    // Trigger lazy eviction by writing a new job
    await req('POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD, AUTH);

    // Expired job must be purged from the live store
    assert.equal(auditJobs.has(expiredId), false, 'Expired job must be evicted from auditJobs');

    // GET must return 410, not 404, so callers know the job existed
    const { status, body } = await req('GET', `/api/v1/compliance/audit/${expiredId}`);
    assert.equal(status, 410);
    assert.equal(body.success, false);
  });

  test('returns 404 (not 410) for a job that never existed', async () => {
    const { status, body } = await req('GET', '/api/v1/compliance/audit/never-existed-xxxx');
    assert.equal(status, 404);
    assert.equal(body.success, false);
  });

  test('non-expired jobs are not evicted', async () => {
    const { body: post } = await req('POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD, AUTH);
    const jobId = post.jobId;

    // The job should still be live
    assert.ok(auditJobs.has(jobId), 'Live job must remain in the store');
    const { status } = await req('GET', `/api/v1/compliance/audit/${jobId}`);
    assert.equal(status, 200);
  });
});

// ---------------------------------------------------------------------------
// Organization registry — verify endpoint
// ---------------------------------------------------------------------------

describe('POST /api/v1/compliance/verify — org registry', () => {
  test('returns 403 when organizationId is not in registry', async () => {
    // Register a different org so the registry is in enforcement mode
    orgRegistry.set('other-org', { licenseKey: 'lk-other', allowedSubs: ['repo:other/*'] });

    const oidcToken = await mintOidcJwt();
    const { status, body } = await req('POST', '/api/v1/compliance/verify', {
      ...VALID_VERIFY_BODY,
      organizationId: 'unknown-org',
      oidcToken,
    });
    assert.equal(status, 403);
    assert.equal(body.success, false);
    assert.match(body.error, /not registered/);
  });

  test('returns 401 when federationRuleId does not match org allowedSubs', async () => {
    orgRegistry.set('acme-corp', {
      licenseKey:  'lk-acme-test',
      allowedSubs: ['repo:owner/repo*'],
    });

    const oidcToken = await mintOidcJwt();
    // federationRuleId belongs to a different owner — not covered by allowedSubs
    const { status, body } = await req('POST', '/api/v1/compliance/verify', {
      ...VALID_VERIFY_BODY,
      organizationId:   'acme-corp',
      federationRuleId: 'repo:other-owner/repo',
      oidcToken,
    });
    assert.equal(status, 401);
    assert.equal(body.success, false);
  });

  test('returns 401 when OIDC sub does not match org allowedSubs', async () => {
    // Use an exact-match pattern so a sub with extra path segments fails
    orgRegistry.set('acme-corp', {
      licenseKey:  'lk-acme-test',
      allowedSubs: ['repo:owner/repo'],   // exact match — no wildcard
    });

    // sub has extra path segments → exact match fails
    const oidcToken = await mintOidcJwt({
      sub: 'repo:owner/repo:ref:refs/heads/main',
    });
    const { status, body } = await req('POST', '/api/v1/compliance/verify', {
      ...VALID_VERIFY_BODY,
      organizationId:   'acme-corp',
      federationRuleId: 'repo:owner/repo',
      oidcToken,
    });
    assert.equal(status, 401);
    assert.equal(body.success, false);
  });

  test('returns 200 when org is registered and sub matches allowedSubs', async () => {
    orgRegistry.set('acme-corp', {
      licenseKey:  'lk-acme-test',
      allowedSubs: ['repo:owner/repo*'],
    });

    const oidcToken = await mintOidcJwt();
    const { status, body } = await req('POST', '/api/v1/compliance/verify', {
      ...VALID_VERIFY_BODY,
      organizationId: 'acme-corp',
      oidcToken,
    });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.ok(body.sessionToken);
  });
});

// ---------------------------------------------------------------------------
// Organization registry — audit endpoint
// ---------------------------------------------------------------------------

describe('POST /api/v1/compliance/audit — org registry', () => {
  test('returns 202 when authenticated via valid session token for registered org', async () => {
    orgRegistry.set('acme-corp', {
      licenseKey:  'lk-acme-test',
      allowedSubs: ['repo:owner/repo*'],
    });

    // Obtain session token via verify
    const oidcToken = await mintOidcJwt();
    const { body: vBody } = await req('POST', '/api/v1/compliance/verify', {
      ...VALID_VERIFY_BODY,
      organizationId: 'acme-corp',
      oidcToken,
    });
    assert.equal(vBody.success, true, 'Expected verify to succeed');

    const { status } = await req(
      'POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD,
      { Authorization: `Bearer ${vBody.sessionToken}` }
    );
    assert.equal(status, 202);
  });

  test('returns 403 when org from session token has been evicted from registry', async () => {
    // Register org, obtain token, then evict org
    orgRegistry.set('acme-corp', {
      licenseKey:  'lk-acme-test',
      allowedSubs: ['repo:owner/repo*'],
    });

    const oidcToken = await mintOidcJwt();
    const { body: vBody } = await req('POST', '/api/v1/compliance/verify', {
      ...VALID_VERIFY_BODY,
      organizationId: 'acme-corp',
      oidcToken,
    });
    assert.equal(vBody.success, true, 'Expected verify to succeed');

    // Evict acme-corp but keep registry in enforcement mode with another org
    orgRegistry.delete('acme-corp');
    orgRegistry.set('other-org', { licenseKey: 'lk-other', allowedSubs: ['repo:other/*'] });

    const { status, body } = await req(
      'POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD,
      { Authorization: `Bearer ${vBody.sessionToken}` }
    );
    assert.equal(status, 403);
    assert.equal(body.success, false);
  });

  test('returns 202 when license key matches a registered org (multi-tenant mode)', async () => {
    orgRegistry.set('acme-corp', {
      licenseKey:  'lk-acme-multitenant',
      allowedSubs: ['repo:owner/repo*'],
    });

    const { status } = await req(
      'POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD,
      { Authorization: 'Bearer lk-acme-multitenant' }
    );
    assert.equal(status, 202);
  });

  test('returns 401 when license key does not match any registered org', async () => {
    orgRegistry.set('acme-corp', {
      licenseKey:  'lk-correct-key',
      allowedSubs: ['repo:owner/repo*'],
    });

    const { status, body } = await req(
      'POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD,
      { Authorization: 'Bearer lk-wrong-key' }
    );
    assert.equal(status, 401);
    assert.equal(body.success, false);
  });
});

// ---------------------------------------------------------------------------
// POST /admin/orgs
// ---------------------------------------------------------------------------

describe('POST /admin/orgs', () => {
  test('returns 503 when ADMIN_SECRET is not configured', async () => {
    const { status, body } = await req(
      'POST', '/admin/orgs',
      { id: 'test-org', licenseKey: 'lk-test', allowedSubs: ['repo:test/*'] },
      { Authorization: 'Bearer any-secret' }
    );
    assert.equal(status, 503);
    assert.equal(body.success, false);
  });

  test('returns 401 when ADMIN_SECRET is set and wrong secret is provided', async () => {
    process.env.ADMIN_SECRET = 'correct-admin-secret';
    const { status, body } = await req(
      'POST', '/admin/orgs',
      { id: 'test-org', licenseKey: 'lk-test', allowedSubs: ['repo:test/*'] },
      { Authorization: 'Bearer wrong-secret' }
    );
    assert.equal(status, 401);
    assert.equal(body.success, false);
  });

  test('returns 401 when Authorization header is absent', async () => {
    process.env.ADMIN_SECRET = 'correct-admin-secret';
    const { status, body } = await req(
      'POST', '/admin/orgs',
      { id: 'test-org', licenseKey: 'lk-test', allowedSubs: ['repo:test/*'] }
    );
    assert.equal(status, 401);
    assert.equal(body.success, false);
  });

  test('returns 200 and registers org when correct ADMIN_SECRET is provided', async () => {
    process.env.ADMIN_SECRET = 'admin-secret-key';
    const { status, body } = await req(
      'POST', '/admin/orgs',
      { id: 'new-org', licenseKey: 'lk-new', allowedSubs: ['repo:new/*'] },
      { Authorization: 'Bearer admin-secret-key' }
    );
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.ok(orgRegistry.has('new-org'));
    const entry = orgRegistry.get('new-org');
    assert.equal(entry.licenseKey, 'lk-new');
    assert.deepEqual(entry.allowedSubs, ['repo:new/*']);
  });

  test('returns 200 and updates an existing org', async () => {
    process.env.ADMIN_SECRET = 'admin-secret-key';
    orgRegistry.set('existing-org', { licenseKey: 'lk-old', allowedSubs: ['repo:old/*'] });

    await req(
      'POST', '/admin/orgs',
      { id: 'existing-org', licenseKey: 'lk-updated', allowedSubs: ['repo:new/*'] },
      { Authorization: 'Bearer admin-secret-key' }
    );
    const entry = orgRegistry.get('existing-org');
    assert.equal(entry.licenseKey, 'lk-updated');
  });

  test('returns 400 when required fields are missing', async () => {
    process.env.ADMIN_SECRET = 'admin-secret';
    const { status, body } = await req(
      'POST', '/admin/orgs',
      { id: 'bad-org' },  // missing licenseKey and allowedSubs
      { Authorization: 'Bearer admin-secret' }
    );
    assert.equal(status, 400);
    assert.equal(body.success, false);
  });

  test('returns 400 when allowedSubs is empty array', async () => {
    process.env.ADMIN_SECRET = 'admin-secret';
    const { status, body } = await req(
      'POST', '/admin/orgs',
      { id: 'bad-org', licenseKey: 'lk-x', allowedSubs: [] },
      { Authorization: 'Bearer admin-secret' }
    );
    assert.equal(status, 400);
    assert.equal(body.success, false);
  });
});

// ---------------------------------------------------------------------------
// File persistence
// ---------------------------------------------------------------------------

describe('File persistence — org registry', () => {
  test('graceful startup when ORGS_FILE does not exist', async () => {
    // ORGS_FILE points to a non-existent path — _loadOrgsFromFile must not throw
    await assert.doesNotReject(() => _loadOrgsFromFile());
    // Registry stays empty when no file exists
    assert.equal(orgRegistry.size, 0);
  });

  test('org registry loaded from ORGS_FILE on startup', async () => {
    const orgsData = [
      { id: 'file-org', licenseKey: 'lk-file', allowedSubs: ['repo:file-org/*'] },
    ];
    await writeFile(process.env.ORGS_FILE, JSON.stringify(orgsData), 'utf8');

    orgRegistry.clear();
    await _loadOrgsFromFile();

    assert.ok(orgRegistry.has('file-org'));
    const entry = orgRegistry.get('file-org');
    assert.equal(entry.licenseKey, 'lk-file');
    assert.deepEqual(entry.allowedSubs, ['repo:file-org/*']);
  });

  test('env-seeded entries (ORGS_CONFIG) take precedence over file entries on conflict', async () => {
    // File has an org with one licenseKey
    const orgsData = [
      { id: 'shared-org', licenseKey: 'lk-from-file', allowedSubs: ['repo:shared/*'] },
    ];
    await writeFile(process.env.ORGS_FILE, JSON.stringify(orgsData), 'utf8');

    // Env has the same org with a different licenseKey
    process.env.ORGS_CONFIG = JSON.stringify([
      { id: 'shared-org', licenseKey: 'lk-from-env', allowedSubs: ['repo:shared/*'] },
    ]);

    orgRegistry.clear();
    await _loadOrgsFromFile();  // sets file entries
    _loadOrgsFromEnv();          // env entries override conflicting file entries

    // env key wins
    assert.equal(orgRegistry.get('shared-org')?.licenseKey, 'lk-from-env');
    delete process.env.ORGS_CONFIG;
  });

  test('org persisted to disk immediately after POST /admin/orgs', async () => {
    process.env.ADMIN_SECRET = 'admin-secret';
    const { status, body } = await req(
      'POST', '/admin/orgs',
      { id: 'persist-org', licenseKey: 'lk-persist', allowedSubs: ['repo:persist/*'] },
      { Authorization: 'Bearer admin-secret' }
    );
    assert.equal(status, 200);
    assert.equal(body.success, true);

    const raw  = await readFile(process.env.ORGS_FILE, 'utf8');
    const orgs = JSON.parse(raw);
    assert.ok(Array.isArray(orgs));
    const org = orgs.find(o => o.id === 'persist-org');
    assert.ok(org, 'org must be present in the persisted file');
    assert.equal(org.licenseKey, 'lk-persist');
    assert.deepEqual(org.allowedSubs, ['repo:persist/*']);
  });

  test('_flushOrgsToFile writes all registry entries atomically', async () => {
    orgRegistry.set('org-a', { licenseKey: 'lk-a', allowedSubs: ['repo:a/*'] });
    orgRegistry.set('org-b', { licenseKey: 'lk-b', allowedSubs: ['repo:b/*'] });

    await _flushOrgsToFile();

    const raw  = await readFile(process.env.ORGS_FILE, 'utf8');
    const orgs = JSON.parse(raw);
    assert.equal(orgs.length, 2);
    assert.ok(orgs.find(o => o.id === 'org-a'));
    assert.ok(orgs.find(o => o.id === 'org-b'));
  });
});

describe('File persistence — audit log', () => {
  const AUTH = { Authorization: 'Bearer test-key' };

  test('graceful startup when AUDIT_LOG_FILE does not exist', async () => {
    // GET on an unknown job must not throw even when log file is absent
    const { status } = await req('GET', '/api/v1/compliance/audit/nonexistent-id');
    assert.equal(status, 404);
  });

  test('completed audit job is appended to AUDIT_LOG_FILE', async () => {
    const { body: post } = await req('POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD, AUTH);
    const jobId = post.jobId;

    const content = await readFile(process.env.AUDIT_LOG_FILE, 'utf8');
    const lines   = content.split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.jobId, jobId);
    assert.equal(record.status, 'complete');
    assert.equal(record.repository, 'acme/widgets');
  });

  test('audit job retrievable from NDJSON log after in-memory store is cleared', async () => {
    const { body: post } = await req('POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD, AUTH);
    const jobId = post.jobId;

    // Simulate a server restart by clearing the in-memory store
    auditJobs.clear();
    evictedJobIds.clear();

    const { status, body } = await req('GET', `/api/v1/compliance/audit/${jobId}`);
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.status, 'complete');
    assert.equal(body.jobId, jobId);
    assert.ok(body.result);
    assert.equal(body.result.repository, 'acme/widgets');
  });

  test('multiple jobs are each appended as separate NDJSON lines', async () => {
    await req('POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD, AUTH);
    await req('POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD, AUTH);

    const content = await readFile(process.env.AUDIT_LOG_FILE, 'utf8');
    const lines   = content.split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    const ids = lines.map(l => JSON.parse(l).jobId);
    assert.notEqual(ids[0], ids[1], 'Each job must have a unique ID');
  });
});

// ---------------------------------------------------------------------------
// GET /admin/orgs
// ---------------------------------------------------------------------------

describe('GET /admin/orgs', () => {
  test('returns 503 when ADMIN_SECRET is not configured', async () => {
    const { status, body } = await req('GET', '/admin/orgs', undefined, {
      Authorization: 'Bearer any-secret',
    });
    assert.equal(status, 503);
    assert.equal(body.success, false);
  });

  test('returns 401 on wrong secret', async () => {
    process.env.ADMIN_SECRET = 'correct-admin-secret';
    const { status, body } = await req('GET', '/admin/orgs', undefined, {
      Authorization: 'Bearer wrong-secret',
    });
    assert.equal(status, 401);
    assert.equal(body.success, false);
  });

  test('returns 401 when Authorization header is absent', async () => {
    process.env.ADMIN_SECRET = 'correct-admin-secret';
    const { status, body } = await req('GET', '/admin/orgs');
    assert.equal(status, 401);
    assert.equal(body.success, false);
  });

  test('returns 200 with empty array when registry is empty', async () => {
    process.env.ADMIN_SECRET = 'admin-secret';
    const { status, body } = await req('GET', '/admin/orgs', undefined, {
      Authorization: 'Bearer admin-secret',
    });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 0);
  });

  test('returns all registered orgs without licenseKey', async () => {
    process.env.ADMIN_SECRET = 'admin-secret';
    orgRegistry.set('org-alpha', { licenseKey: 'lk-secret-alpha', allowedSubs: ['repo:alpha/*'] });
    orgRegistry.set('org-beta',  { licenseKey: 'lk-secret-beta',  allowedSubs: ['repo:beta/*'] });

    const { status, body } = await req('GET', '/admin/orgs', undefined, {
      Authorization: 'Bearer admin-secret',
    });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 2);

    const alpha = body.find(o => o.id === 'org-alpha');
    assert.ok(alpha);
    assert.deepEqual(alpha.allowedSubs, ['repo:alpha/*']);
    assert.equal('licenseKey' in alpha, false, 'licenseKey must not be returned');

    const beta = body.find(o => o.id === 'org-beta');
    assert.ok(beta);
    assert.equal('licenseKey' in beta, false, 'licenseKey must not be returned');
  });
});

// ---------------------------------------------------------------------------
// DELETE /admin/orgs/:id
// ---------------------------------------------------------------------------

describe('DELETE /admin/orgs/:id', () => {
  test('returns 503 when ADMIN_SECRET is not configured', async () => {
    const { status, body } = await req('DELETE', '/admin/orgs/some-org', undefined, {
      Authorization: 'Bearer any-secret',
    });
    assert.equal(status, 503);
    assert.equal(body.success, false);
  });

  test('returns 401 on wrong secret', async () => {
    process.env.ADMIN_SECRET = 'correct-admin-secret';
    const { status, body } = await req('DELETE', '/admin/orgs/some-org', undefined, {
      Authorization: 'Bearer wrong-secret',
    });
    assert.equal(status, 401);
    assert.equal(body.success, false);
  });

  test('returns 404 when org is not registered', async () => {
    process.env.ADMIN_SECRET = 'admin-secret';
    const { status, body } = await req('DELETE', '/admin/orgs/unknown-org', undefined, {
      Authorization: 'Bearer admin-secret',
    });
    assert.equal(status, 404);
    assert.equal(body.success, false);
    assert.match(body.error, /unknown-org/);
  });

  test('returns 200 and removes org from the in-memory registry', async () => {
    process.env.ADMIN_SECRET = 'admin-secret';
    orgRegistry.set('del-org', { licenseKey: 'lk-del', allowedSubs: ['repo:del/*'] });

    const { status, body } = await req('DELETE', '/admin/orgs/del-org', undefined, {
      Authorization: 'Bearer admin-secret',
    });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.match(body.message, /del-org/);
    assert.equal(orgRegistry.has('del-org'), false, 'Org must be removed from registry');
  });

  test('flushes updated registry to disk after deletion', async () => {
    process.env.ADMIN_SECRET = 'admin-secret';
    orgRegistry.set('flush-org-a', { licenseKey: 'lk-a', allowedSubs: ['repo:a/*'] });
    orgRegistry.set('flush-org-b', { licenseKey: 'lk-b', allowedSubs: ['repo:b/*'] });

    // Delete one org
    const { status } = await req('DELETE', '/admin/orgs/flush-org-a', undefined, {
      Authorization: 'Bearer admin-secret',
    });
    assert.equal(status, 200);

    // Persisted file must contain only flush-org-b
    const raw  = await readFile(process.env.ORGS_FILE, 'utf8');
    const orgs = JSON.parse(raw);
    assert.ok(Array.isArray(orgs));
    assert.equal(orgs.find(o => o.id === 'flush-org-a'), undefined, 'Deleted org must not be in file');
    assert.ok(orgs.find(o => o.id === 'flush-org-b'), 'Remaining org must still be in file');
  });

  test('second delete of same org returns 404', async () => {
    process.env.ADMIN_SECRET = 'admin-secret';
    orgRegistry.set('once-org', { licenseKey: 'lk-once', allowedSubs: ['repo:once/*'] });

    await req('DELETE', '/admin/orgs/once-org', undefined, {
      Authorization: 'Bearer admin-secret',
    });

    // Second delete — org no longer exists
    const { status, body } = await req('DELETE', '/admin/orgs/once-org', undefined, {
      Authorization: 'Bearer admin-secret',
    });
    assert.equal(status, 404);
    assert.equal(body.success, false);
  });
});

// ---------------------------------------------------------------------------
// GET /admin/audit-jobs
// ---------------------------------------------------------------------------

describe('GET /admin/audit-jobs', () => {
  const ADMIN = { Authorization: 'Bearer admin-secret' };
  const AUTH  = { Authorization: 'Bearer test-key' };

  test('returns 503 when ADMIN_SECRET is not configured', async () => {
    const { status, body } = await req('GET', '/admin/audit-jobs', undefined, {
      Authorization: 'Bearer any-secret',
    });
    assert.equal(status, 503);
    assert.equal(body.success, false);
  });

  test('returns 401 on wrong secret', async () => {
    process.env.ADMIN_SECRET = 'correct-admin-secret';
    const { status, body } = await req('GET', '/admin/audit-jobs', undefined, {
      Authorization: 'Bearer wrong-secret',
    });
    assert.equal(status, 401);
    assert.equal(body.success, false);
  });

  test('returns 200 with empty array when store is empty', async () => {
    process.env.ADMIN_SECRET = 'admin-secret';
    const { status, body } = await req('GET', '/admin/audit-jobs', undefined, ADMIN);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 0);
  });

  test('returns job summaries after audit jobs are submitted', async () => {
    process.env.ADMIN_SECRET = 'admin-secret';
    await req('POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD, AUTH);
    await req('POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD, AUTH);

    const { status, body } = await req('GET', '/admin/audit-jobs', undefined, ADMIN);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 2);

    const summary = body[0];
    assert.ok(typeof summary.jobId      === 'string');
    assert.ok(typeof summary.repository === 'string');
    assert.ok(typeof summary.tag        === 'string');
    assert.ok(typeof summary.status     === 'string');
    assert.ok(typeof summary.submittedAt === 'string');
    assert.equal(summary.repository, 'acme/widgets');
    assert.equal(summary.tag, 'v1.2.0');
    assert.equal(summary.status, 'complete');
  });

  test('does not include the full result payload in summaries', async () => {
    process.env.ADMIN_SECRET = 'admin-secret';
    await req('POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD, AUTH);

    const { body } = await req('GET', '/admin/audit-jobs', undefined, ADMIN);
    assert.equal(body.length, 1);
    assert.equal('result' in body[0], false, 'result payload must not appear in job summaries');
  });

  test('returns jobs sorted by submittedAt descending (newest first)', async () => {
    process.env.ADMIN_SECRET = 'admin-secret';
    await req('POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD, AUTH);
    await req('POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD, AUTH);

    const { body } = await req('GET', '/admin/audit-jobs', undefined, ADMIN);
    assert.equal(body.length, 2);
    // ISO strings are lexicographically comparable; newest must not be after index 0
    assert.ok(body[0].submittedAt >= body[1].submittedAt, 'Jobs must be sorted newest first');
  });

  test('completedAt is present in summary for completed jobs', async () => {
    process.env.ADMIN_SECRET = 'admin-secret';
    await req('POST', '/api/v1/compliance/audit', VALID_AUDIT_PAYLOAD, AUTH);

    const { body } = await req('GET', '/admin/audit-jobs', undefined, ADMIN);
    assert.equal(body.length, 1);
    assert.ok(typeof body[0].completedAt === 'string', 'completedAt must be present for complete jobs');
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

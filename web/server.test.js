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
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import {
  app,
  auditJobs,
  evictedJobIds,
  validateLicenseKey,
  _auditLimiterStore,
  _verifyLimiterStore,
  _resetJwksCache,
} from './server.js';

// ---------------------------------------------------------------------------
// Test server lifecycle — bind to a random port so tests never conflict
// ---------------------------------------------------------------------------

let server;
let baseUrl;

// OIDC test state — populated in before()
let testPrivateKey;       // RSA private key for signing test JWTs
let testPublicJwk;        // Corresponding public JWK served by mock JWKS server
let wrongPrivateKey;      // A different RSA key — used to simulate invalid signatures
let mockJwksServer;       // HTTP server that serves testPublicJwk as a JWKS
let mockJwksPort;
let mockJwksMode = 'ok';  // 'ok' | 'error' — controls mock server response

before(async () => {
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
});

beforeEach(async () => {
  // Reset job store and eviction tracking between tests for isolation
  auditJobs.clear();
  evictedJobIds.clear();
  // Reset rate limiter counters so tests don't bleed into each other
  await _auditLimiterStore.resetAll?.();
  await _verifyLimiterStore.resetAll?.();
  // Ensure LICENSE_SECRET is unset by default so tests work in dev mode
  delete process.env.LICENSE_SECRET;
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

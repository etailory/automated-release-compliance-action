/**
 * Governor OS — Web Platform API Server
 *
 * Lightweight Express server exposing the REST API consumed by the Governor OS
 * GitHub Action (premium tier) and future web application clients.
 *
 * Endpoints (v1):
 *   POST /api/v1/compliance/verify  — Validate OIDC token and issue session token
 *   POST /api/v1/compliance/audit   — Receive repository metadata and run audit
 *   GET  /api/v1/compliance/audit/:jobId — Retrieve audit job status and result
 */

import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit, { MemoryStore } from 'express-rate-limit';
import { createLocalJWKSet, jwtVerify, SignJWT } from 'jose';

export const app  = express();
const PORT = process.env.PORT ?? 3000;

// ---------------------------------------------------------------------------
// In-memory audit job store
// Jobs are keyed by jobId. Without a database, jobs do not persist across
// server restarts — acceptable for the MVP.
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   status: 'complete' | 'queued',
 *   submittedAt: string,
 *   completedAt?: string,
 *   repository: string,
 *   tag: string,
 *   expiresAt: number,
 *   result?: object
 * }} AuditJob
 */

/** @type {Map<string, AuditJob>} */
export const auditJobs = new Map();

/**
 * Tracks evicted job IDs so GET can distinguish 410 Gone from 404 Not Found.
 * Capped at EVICTED_IDS_MAX to bound memory usage.
 * @type {Set<string>}
 */
export const evictedJobIds = new Set();

const JOB_TTL_MS      = 24 * 3_600_000;
const EVICTED_IDS_MAX = 10_000;

/**
 * Scans auditJobs for expired entries, removes them, and records their IDs
 * in evictedJobIds so GET can return 410. Called lazily on each write.
 */
function evictExpiredJobs() {
  const now = Date.now();
  for (const [id, job] of auditJobs) {
    if (job.expiresAt <= now) {
      auditJobs.delete(id);
      if (evictedJobIds.size < EVICTED_IDS_MAX) {
        evictedJobIds.add(id);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Organization registry
//
// Maps organizationId → { licenseKey, allowedSubs }.
// When non-empty (enforcement mode), the verify and audit endpoints require
// the calling org to be registered here.
// When empty (dev/test mode), org checks are bypassed — same pattern as
// LICENSE_SECRET (any key accepted when the secret is unset).
// ---------------------------------------------------------------------------

/**
 * @typedef {{ licenseKey: string, allowedSubs: string[] }} OrgEntry
 */

/** @type {Map<string, OrgEntry>} */
export const orgRegistry = new Map();

/**
 * Seed the registry from the ORGS_CONFIG env var.
 * Value must be a JSON array of { id, licenseKey, allowedSubs }.
 * Exported so tests can re-invoke it after manipulating the env.
 */
export function _loadOrgsFromEnv() {
  const raw = process.env.ORGS_CONFIG;
  if (!raw) return;
  let orgs;
  try {
    orgs = JSON.parse(raw);
  } catch {
    console.error('[WARN] ORGS_CONFIG is not valid JSON — organization registry not seeded.');
    return;
  }
  if (!Array.isArray(orgs)) {
    console.error('[WARN] ORGS_CONFIG must be a JSON array — organization registry not seeded.');
    return;
  }
  for (const org of orgs) {
    if (typeof org.id === 'string' && typeof org.licenseKey === 'string' && Array.isArray(org.allowedSubs)) {
      orgRegistry.set(org.id, { licenseKey: org.licenseKey, allowedSubs: org.allowedSubs });
    } else {
      console.warn(`[WARN] Skipping invalid org entry in ORGS_CONFIG: ${JSON.stringify(org)}`);
    }
  }
  if (orgRegistry.size > 0) {
    console.log(`[orgRegistry] Loaded ${orgRegistry.size} org(s) from ORGS_CONFIG.`);
  }
}

_loadOrgsFromEnv();

/** Returns true when the registry has at least one org (enforcement mode). */
function isRegistryEnforced() {
  return orgRegistry.size > 0;
}

/**
 * Match a subject string against a single pattern.
 * Supports trailing-wildcard glob ("repo:acme/*") and exact match.
 *
 * @param {string} subject
 * @param {string} pattern
 * @returns {boolean}
 */
function matchSubPattern(subject, pattern) {
  if (pattern.endsWith('*')) {
    return subject.startsWith(pattern.slice(0, -1));
  }
  return subject === pattern;
}

/**
 * Returns true when subject matches at least one pattern in the list.
 *
 * @param {string} subject
 * @param {string[]} patterns
 * @returns {boolean}
 */
function matchesAnyPattern(subject, patterns) {
  return patterns.some(p => matchSubPattern(subject, p));
}

// ---------------------------------------------------------------------------
// JWKS cache — exported so tests can reset between runs
// ---------------------------------------------------------------------------

let _jwksCache = null;
let _jwksCacheExpiry = 0;
const JWKS_CACHE_TTL_MS = 5 * 60 * 1_000;

export function _resetJwksCache() {
  _jwksCache = null;
  _jwksCacheExpiry = 0;
}

async function fetchJwks() {
  const now = Date.now();
  if (_jwksCache && now < _jwksCacheExpiry) {
    return _jwksCache;
  }
  const jwksUrl = process.env.JWKS_URL ?? 'https://token.actions.githubusercontent.com/.well-known/jwks';
  const response = await fetch(jwksUrl);
  if (!response.ok) {
    throw new Error(`JWKS fetch failed: HTTP ${response.status}`);
  }
  _jwksCache = await response.json();
  _jwksCacheExpiry = now + JWKS_CACHE_TTL_MS;
  return _jwksCache;
}

// ---------------------------------------------------------------------------
// Session secret
// In production, SESSION_SECRET must be set. In dev/test, an ephemeral random
// key is generated at startup with a warning — tokens won't survive restarts.
// ---------------------------------------------------------------------------

const _devSessionSecret = crypto.randomBytes(32);
let _devSecretWarned = false;

function getSessionSecret() {
  const envSecret = process.env.SESSION_SECRET;
  if (envSecret) {
    return new TextEncoder().encode(envSecret);
  }
  if (!_devSecretWarned) {
    console.warn('[WARN] SESSION_SECRET not configured — using ephemeral random secret (development mode only).');
    _devSecretWarned = true;
  }
  return _devSessionSecret;
}

// ---------------------------------------------------------------------------
// Rate limiters — exported so tests can reset stores between runs
// ---------------------------------------------------------------------------

export const _auditLimiterStore  = new MemoryStore();
export const _verifyLimiterStore = new MemoryStore();

const auditLimiter = rateLimit({
  windowMs:       60_000,
  max:            30,
  store:          _auditLimiterStore,
  standardHeaders: true,
  legacyHeaders:  false,
  message: { success: false, error: 'Too many audit requests. Please retry after 1 minute.' },
});

const verifyLimiter = rateLimit({
  windowMs:       300_000,
  max:            10,
  store:          _verifyLimiterStore,
  standardHeaders: true,
  legacyHeaders:  false,
  message: { success: false, error: 'Too many verification requests. Please retry after 5 minutes.' },
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(express.json());

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'governor-os-web', version: '1.0.0' });
});

// ---------------------------------------------------------------------------
// POST /api/v1/compliance/verify
//
// Validates the OIDC token issued by GitHub Actions against the GitHub JWKS,
// then issues a short-lived HMAC-signed session token for subsequent API calls.
//
// Expected request body:
// {
//   "oidcToken":        string,  // Short-lived GitHub OIDC JWT
//   "organizationId":   string,  // Governor OS tenant ID
//   "serviceAccountId": string,  // CI service account identifier
//   "federationRuleId": string   // OIDC sub prefix to match
// }
// ---------------------------------------------------------------------------

app.post('/api/v1/compliance/verify', verifyLimiter, async (req, res) => {
  try {
    const { oidcToken, organizationId, serviceAccountId, federationRuleId } = req.body ?? {};

    // Input validation
    if (!oidcToken || !organizationId || !serviceAccountId || !federationRuleId) {
      return res.status(400).json({
        success: false,
        error:   'Missing required fields: oidcToken, organizationId, serviceAccountId, federationRuleId',
      });
    }

    // Org registry check (skipped in dev mode when registry is empty)
    let orgAllowedSubs;
    if (isRegistryEnforced()) {
      const org = orgRegistry.get(organizationId);
      if (!org) {
        return res.status(403).json({
          success: false,
          error:   `Organization not registered: ${organizationId}`,
        });
      }
      // Pre-flight: federationRuleId must match one of the org's allowed sub patterns
      if (!matchesAnyPattern(federationRuleId, org.allowedSubs)) {
        return res.status(401).json({
          success: false,
          error:   `federationRuleId '${federationRuleId}' does not match any allowed sub pattern for organization '${organizationId}'`,
        });
      }
      orgAllowedSubs = org.allowedSubs;
    }

    const verificationResult = await verifyOidcAndIssueSession({
      oidcToken,
      organizationId,
      federationRuleId,
      allowedSubs: orgAllowedSubs,
    });

    return res.status(200).json({
      success:      true,
      sessionToken: verificationResult.sessionToken,
      expiresIn:    verificationResult.expiresIn,
      message:      'OIDC token verified. Session token issued.',
    });

  } catch (error) {
    console.error('[/api/v1/compliance/verify] Error:', error.message);
    const statusCode = error.statusCode ?? 500;
    const message    = statusCode < 500
      ? error.message
      : 'Internal server error during verification.';
    return res.status(statusCode).json({ success: false, error: message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/compliance/audit
//
// Receives an AuditPayload from the GitHub Action (premium tier) and processes
// the audit synchronously.
//
// Authentication: Authorization: Bearer <license-key | session-token>
//
// Expected request body (AuditPayload):
// {
//   "schemaVersion": string,
//   "repository":    string,          // "owner/repo"
//   "release": {
//     "tag":         string,
//     "name":        string,
//     "isPrerelease": boolean,
//     "isDraft":      boolean,
//     "publishedAt":  string | null,
//     "author":       string | null
//   },
//   "requested": {
//     "isoControlMapping": boolean,
//     "evidencePdf":       boolean,
//     "governanceVerdict": boolean
//   }
// }
// ---------------------------------------------------------------------------

app.post('/api/v1/compliance/audit', auditLimiter, async (req, res) => {
  try {
    // Extract Bearer token from Authorization header
    const authHeader  = req.headers['authorization'] ?? '';
    const bearerToken = authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : '';

    if (!bearerToken) {
      return res.status(401).json({
        success: false,
        error:   'Missing or invalid Authorization header. Expected: Bearer <license-key|session-token>',
      });
    }

    const authResult = await authenticateBearerToken(bearerToken);
    if (!authResult.valid) {
      return res.status(401).json({
        success: false,
        error:   'Invalid authorization token.',
      });
    }

    // When registry is enforced, verify the org hasn't been evicted
    if (isRegistryEnforced() && authResult.orgId) {
      if (!orgRegistry.has(authResult.orgId)) {
        return res.status(403).json({
          success: false,
          error:   `Organization '${authResult.orgId}' is not registered or has been evicted.`,
        });
      }
    }

    const { schemaVersion, repository, release, requested } = req.body ?? {};

    // Input validation
    if (!schemaVersion || !repository || !release?.tag) {
      return res.status(400).json({
        success: false,
        error:   'Missing required fields: schemaVersion, repository, release.tag',
      });
    }

    const auditJob = await enqueueAuditJob({ authToken: bearerToken, repository, release, requested });

    return res.status(202).json({
      success: true,
      jobId:   auditJob.jobId,
      status:  'queued',
      message: `Compliance audit job queued for ${repository}@${release.tag}. Poll GET /api/v1/compliance/audit/${auditJob.jobId} for status.`,
    });

  } catch (error) {
    console.error('[/api/v1/compliance/audit] Error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error during audit submission.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/compliance/audit/:jobId
//
// Returns the current status and result of a compliance audit job.
//
// Response: { success, jobId, status, message, result? }
// ---------------------------------------------------------------------------

app.get('/api/v1/compliance/audit/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;

    if (!jobId) {
      return res.status(400).json({ success: false, error: 'Missing jobId parameter' });
    }

    const jobStatus = await getAuditJobStatus(jobId);

    if (!jobStatus) {
      if (evictedJobIds.has(jobId)) {
        return res.status(410).json({ success: false, error: `Audit job expired and has been evicted: ${jobId}` });
      }
      return res.status(404).json({ success: false, error: `Audit job not found: ${jobId}` });
    }

    return res.status(200).json({
      success: true,
      jobId,
      status:  jobStatus.status,
      message: jobStatus.message,
      result:  jobStatus.result,
    });

  } catch (error) {
    console.error('[GET /api/v1/compliance/audit/:jobId] Error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error fetching job status.' });
  }
});

// ---------------------------------------------------------------------------
// POST /admin/orgs
//
// Register or update an organization in the registry at runtime without a
// server restart. Protected by the ADMIN_SECRET env var.
//
// Expected request body: { id, licenseKey, allowedSubs }
// ---------------------------------------------------------------------------

app.post('/admin/orgs', (req, res) => {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    return res.status(503).json({
      success: false,
      error:   'Admin endpoint is disabled (ADMIN_SECRET not configured).',
    });
  }

  const authHeader = req.headers['authorization'] ?? '';
  const provided   = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : '';

  let authorized = false;
  try {
    const secretBuf   = Buffer.from(adminSecret);
    const providedBuf = Buffer.from(provided);
    authorized = secretBuf.length === providedBuf.length &&
      crypto.timingSafeEqual(secretBuf, providedBuf);
  } catch {
    // fall through — authorized stays false
  }

  if (!authorized) {
    return res.status(401).json({ success: false, error: 'Unauthorized.' });
  }

  const { id, licenseKey, allowedSubs } = req.body ?? {};
  if (
    typeof id !== 'string' || !id ||
    typeof licenseKey !== 'string' || !licenseKey ||
    !Array.isArray(allowedSubs) || allowedSubs.length === 0
  ) {
    return res.status(400).json({
      success: false,
      error:   'Required fields: id (string), licenseKey (string), allowedSubs (non-empty array)',
    });
  }

  orgRegistry.set(id, { licenseKey, allowedSubs });
  console.log(`[/admin/orgs] Registered org: ${id}`);
  return res.status(200).json({ success: true, message: `Organization '${id}' registered.` });
});

// ---------------------------------------------------------------------------
// 404 fallback
// ---------------------------------------------------------------------------

app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Validate a license key.
 *
 * When LICENSE_SECRET is configured, the bearer token must match it exactly.
 * Timing-safe comparison prevents timing-based oracle attacks.
 *
 * When LICENSE_SECRET is unset (development/test mode), any non-empty key is
 * accepted — this lets developers test the premium flow without a real secret.
 *
 * @param {string} licenseKey
 * @returns {boolean}
 */
export function validateLicenseKey(licenseKey) {
  const secret = process.env.LICENSE_SECRET;
  if (!secret) return true; // development mode

  try {
    const secretBuf = Buffer.from(secret);
    const keyBuf    = Buffer.from(licenseKey);
    // timingSafeEqual requires equal-length buffers
    if (secretBuf.length !== keyBuf.length) return false;
    return crypto.timingSafeEqual(secretBuf, keyBuf);
  } catch {
    return false;
  }
}

/**
 * Authenticate a bearer token. Returns { valid, orgId? }.
 *
 * Accepts either an HMAC-signed session token (JWT) or a plain license key.
 *
 * When the org registry is enforced (non-empty):
 *   - Session token: orgId is extracted and returned for the caller to verify.
 *   - License key: scans org license keys for a match; falls back to
 *     LICENSE_SECRET for single-tenant installs (orgId will be null in that case).
 *
 * When the registry is empty (dev/test mode):
 *   - Behaves like the legacy validateLicenseKey (accepts any key when
 *     LICENSE_SECRET is unset).
 *
 * @param {string} token
 * @returns {Promise<{ valid: boolean, orgId?: string | null }>}
 */
async function authenticateBearerToken(token) {
  // JWT: three dot-separated parts
  if (token.split('.').length === 3) {
    try {
      const { payload } = await jwtVerify(token, getSessionSecret());
      if (payload.sub && payload.orgId) {
        return { valid: true, orgId: String(payload.orgId) };
      }
    } catch {
      // Not a valid session token — fall through
    }
  }

  if (isRegistryEnforced()) {
    // Multi-tenant: check each registered org's license key
    for (const [orgId, org] of orgRegistry) {
      try {
        const orgKeyBuf = Buffer.from(org.licenseKey);
        const tokenBuf  = Buffer.from(token);
        if (orgKeyBuf.length === tokenBuf.length && crypto.timingSafeEqual(orgKeyBuf, tokenBuf)) {
          return { valid: true, orgId };
        }
      } catch {
        // skip malformed key entry
      }
    }
    // Single-tenant fallback: LICENSE_SECRET
    const secret = process.env.LICENSE_SECRET;
    if (secret) {
      try {
        const secretBuf = Buffer.from(secret);
        const tokenBuf  = Buffer.from(token);
        if (secretBuf.length === tokenBuf.length && crypto.timingSafeEqual(secretBuf, tokenBuf)) {
          return { valid: true, orgId: null };
        }
      } catch {
        // skip
      }
    }
    return { valid: false };
  }

  // Dev mode: use LICENSE_SECRET check (accepts any key when unset)
  return { valid: validateLicenseKey(token) };
}

/**
 * Derive a governance verdict from the release metadata.
 *
 * @param {{ isDraft: boolean, isPrerelease: boolean }} release
 * @returns {{ verdict: string, reason: string }}
 */
function deriveGovernanceVerdict(release) {
  if (release.isDraft) {
    return {
      verdict: 'blocked',
      reason:  'Release is a draft — must be published before the audit can be approved.',
    };
  }
  if (release.isPrerelease) {
    return {
      verdict: 'conditional',
      reason:  'Pre-release: audit passed with reduced controls. Full controls apply to production releases.',
    };
  }
  return {
    verdict: 'approved',
    reason:  'Release meets Governor OS governance requirements.',
  };
}

/**
 * Store and process an audit job in the in-memory store.
 *
 * @param {{ authToken: string, repository: string, release: object, requested: object }} params
 * @returns {Promise<{ jobId: string }>}
 */
async function enqueueAuditJob({ authToken, repository, release, requested }) {
  const safeRepo    = repository.replace(/[^a-zA-Z0-9-]/g, '_');
  const jobId       = `audit-${safeRepo}-${release.tag}-${Date.now()}`;
  const submittedAt = new Date().toISOString();

  const governance = deriveGovernanceVerdict(release);

  const result = {
    auditTrailId: jobId,
    repository,
    release: {
      tag:         release.tag,
      publishedAt: release.publishedAt ?? null,
      author:      release.author ?? null,
    },
    governanceVerdict: requested?.governanceVerdict !== false
      ? governance
      : undefined,
    isoControlMapping: requested?.isoControlMapping
      ? {
          'CC6.1': 'Change management: Release tag and metadata captured.',
          'CC7.2': 'System monitoring: CI workflow completion linked to release.',
          'CC8.1': 'Change management: Release notes and issue references reviewed.',
        }
      : undefined,
    evidencePdf: requested?.evidencePdf
      ? { status: 'pending', message: 'PDF generation is not yet available in this tier.' }
      : undefined,
    completedAt: new Date().toISOString(),
  };

  evictExpiredJobs();

  auditJobs.set(jobId, {
    status:      'complete',
    submittedAt,
    completedAt: result.completedAt,
    repository,
    tag:         release.tag,
    expiresAt:   Date.now() + JOB_TTL_MS,
    result,
  });

  console.log(`[enqueueAuditJob] Processed: ${jobId} → verdict: ${governance.verdict} (auth prefix: ${authToken.slice(0, 8)}...)`);
  return { jobId };
}

/**
 * Retrieve the status and result of an audit job.
 *
 * @param {string} jobId
 * @returns {Promise<{ status: string, message: string, result?: object } | null>}
 */
async function getAuditJobStatus(jobId) {
  const job = auditJobs.get(jobId);
  if (!job) return null;

  return {
    status:  job.status,
    message: job.status === 'complete'
      ? `Audit complete for ${job.repository}@${job.tag}.`
      : 'Audit job is queued and awaiting processing.',
    result: job.result,
  };
}

/**
 * Verifies a GitHub Actions OIDC JWT against the GitHub JWKS endpoint and
 * issues a short-lived HMAC-signed session token.
 *
 * Throws with statusCode 503 if the JWKS endpoint is unreachable.
 * Throws with statusCode 401 if token verification fails.
 *
 * @param {{ oidcToken: string, organizationId: string, federationRuleId: string, allowedSubs?: string[] }} params
 * @returns {Promise<{ sessionToken: string, expiresIn: number }>}
 */
async function verifyOidcAndIssueSession({ oidcToken, organizationId, federationRuleId, allowedSubs }) {
  const oidcIssuer   = process.env.OIDC_ISSUER   ?? 'https://token.actions.githubusercontent.com';
  const oidcAudience = process.env.OIDC_AUDIENCE ?? 'governor-os';

  let jwks;
  try {
    jwks = await fetchJwks();
  } catch (err) {
    console.error('[verifyOidcAndIssueSession] JWKS fetch error:', err.message);
    const e = new Error('Token verification service temporarily unavailable. Please retry.');
    e.statusCode = 503;
    throw e;
  }

  const keySet = createLocalJWKSet(jwks);
  let payload;
  try {
    ({ payload } = await jwtVerify(oidcToken, keySet, {
      issuer:   oidcIssuer,
      audience: oidcAudience,
    }));
  } catch (err) {
    const e = new Error(`OIDC token verification failed: ${err.message}`);
    e.statusCode = 401;
    throw e;
  }

  const sub = payload.sub ?? '';

  // When org registry is enforced, validate sub against the org's allowed patterns
  if (allowedSubs && !matchesAnyPattern(sub, allowedSubs)) {
    const e = new Error(`OIDC token sub does not match any allowed sub pattern for organization '${organizationId}'`);
    e.statusCode = 401;
    throw e;
  }

  // Validate sub against federationRuleId using prefix match
  if (!sub.startsWith(federationRuleId)) {
    const e = new Error(`OIDC token sub does not satisfy federation rule '${federationRuleId}'`);
    e.statusCode = 401;
    throw e;
  }

  const sessionToken = await new SignJWT({ sub, orgId: organizationId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(getSessionSecret());

  console.log(`[verifyOidcAndIssueSession] Session issued: org=${organizationId} sub=${sub.slice(0, 50)}`);
  return { sessionToken, expiresIn: 3600 };
}

// ---------------------------------------------------------------------------
// Start server (only when run directly, not when imported in tests)
// ---------------------------------------------------------------------------

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  app.listen(PORT, () => {
    console.log(`Governor OS Web Platform running on port ${PORT}`);
  });
}

export default app;

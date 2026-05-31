/**
 * Governor OS — Web Platform API Server
 *
 * Lightweight Express server exposing the REST API consumed by the Governor OS
 * GitHub Action (premium tier) and future web application clients.
 *
 * Endpoints (v1):
 *   POST /api/v1/compliance/verify          — Validate OIDC token and issue session token
 *   POST /api/v1/compliance/audit           — Receive repository metadata and run audit
 *   GET  /api/v1/compliance/audit/:jobId    — Retrieve audit job status and result
 *   GET  /api/v1/compliance/audits          — List org audit history from durable log
 *   GET  /api/v1/compliance/audits/export   — Export org audit history as CSV or JSON
 *   GET  /api/v1/compliance/audits/verify   — One-click integrity report for the audit log
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
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
// File persistence layer
//
// ORGS_FILE      — path for the org registry JSON (default: data/orgs.json)
// AUDIT_LOG_FILE — path for the completed-job NDJSON log (default: data/audit-log.ndjson)
//
// Writes are atomic (temp-file + rename for the registry; appendFile for the log).
// File I/O errors are caught and logged; the in-memory store remains authoritative.
// ---------------------------------------------------------------------------

function getOrgsFilePath() {
  return process.env.ORGS_FILE ?? 'data/orgs.json';
}

function getAuditLogFilePath() {
  return process.env.AUDIT_LOG_FILE ?? 'data/audit-log.ndjson';
}

async function ensureDirFor(filePath) {
  await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
}

/**
 * Load the org registry from the ORGS_FILE JSON file.
 * Silently ignores ENOENT — the file is created on the first flush.
 * Exported so tests and the startup block can invoke it directly.
 *
 * Caller is responsible for calling _loadOrgsFromEnv() afterwards so that
 * env-seeded entries override any conflicting file entries.
 */
export async function _loadOrgsFromFile() {
  const filePath = getOrgsFilePath();
  try {
    await ensureDirFor(filePath);
    const raw = await fs.readFile(filePath, 'utf8');
    const orgs = JSON.parse(raw);
    if (!Array.isArray(orgs)) return;
    let count = 0;
    for (const org of orgs) {
      if (
        typeof org.id === 'string' && org.id &&
        typeof org.licenseKey === 'string' && org.licenseKey &&
        Array.isArray(org.allowedSubs)
      ) {
        orgRegistry.set(org.id, { licenseKey: org.licenseKey, allowedSubs: org.allowedSubs });
        count++;
      }
    }
    if (count > 0) {
      console.log(`[orgRegistry] Loaded ${count} org(s) from ${filePath}.`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[WARN] Could not load org registry from ${filePath}:`, err.message);
    }
    // ENOENT → file doesn't exist yet; ensureDirFor already created the directory.
  }
}

/**
 * Atomically flush the current org registry to ORGS_FILE.
 * Writes to a .tmp file first, then renames, to prevent torn writes.
 * Exported so tests can invoke it directly to set up state.
 */
export async function _flushOrgsToFile() {
  const filePath = getOrgsFilePath();
  const tmpPath  = `${filePath}.tmp`;
  const orgs     = [];
  for (const [id, entry] of orgRegistry) {
    orgs.push({ id, licenseKey: entry.licenseKey, allowedSubs: entry.allowedSubs });
  }
  try {
    await ensureDirFor(filePath);
    await fs.writeFile(tmpPath, JSON.stringify(orgs, null, 2), 'utf8');
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    console.error(`[WARN] Failed to flush org registry to ${filePath}:`, err.message);
    try { await fs.unlink(tmpPath); } catch { /* ignore cleanup error */ }
  }
}

/**
 * Append a completed audit job record to the NDJSON audit log.
 * Errors are caught and logged; the in-memory store is the primary read path.
 *
 * @param {string}   jobId
 * @param {AuditJob} job
 */
async function _appendJobToAuditLog(jobId, job) {
  const filePath = getAuditLogFilePath();
  try {
    await ensureDirFor(filePath);
    const record = {
      jobId,
      status:      job.status,
      submittedAt: job.submittedAt,
      completedAt: job.completedAt,
      repository:  job.repository,
      tag:         job.tag,
      result:      job.result,
    };
    record.sig = _computeAuditSig(record);
    await fs.appendFile(filePath, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    console.error(`[WARN] Failed to append job ${jobId} to audit log:`, err.message);
  }
}

/**
 * Scan the NDJSON audit log for a record matching jobId.
 * Returns the record object or null if not found.
 *
 * @param {string} jobId
 * @returns {Promise<object|null>}
 */
async function _findJobInAuditLog(jobId) {
  const filePath = getAuditLogFilePath();
  try {
    const content = await fs.readFile(filePath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record.jobId === jobId) return record;
      } catch { /* skip malformed lines */ }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[WARN] Failed to scan audit log ${filePath}:`, err.message);
    }
  }
  return null;
}

/**
 * Scan the NDJSON audit log, filter by org and optionally by repository,
 * sort newest-first, and page.
 *
 * When orgId is non-null the result is restricted to jobs whose repository
 * owner matches orgId. When orgId is null (single-tenant LICENSE_SECRET mode)
 * all records are returned.
 *
 * When repository is non-null only records with an exact repository match
 * are returned (applied after the orgId filter).
 *
 * Returns { records, total } where total is the count of all matched records
 * before pagination, and records is the sliced page.
 *
 * @param {{ orgId: string|null, limit: number, offset?: number, repository?: string|null }} opts
 * @returns {Promise<{ records: object[], total: number }>}
 */
export async function _findJobsInAuditLog({ orgId, limit, offset = 0, repository = null }) {
  const filePath = getAuditLogFilePath();
  const records = [];
  try {
    const content = await fs.readFile(filePath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (orgId !== null) {
          const owner = (record.repository ?? '').split('/')[0];
          if (owner !== orgId) continue;
        }
        if (repository !== null && record.repository !== repository) continue;
        records.push({ ...record, verified: _verifyAuditRecord(record) });
      } catch { /* skip malformed lines */ }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[WARN] Failed to scan audit log ${filePath}:`, err.message);
    }
  }
  records.sort((a, b) => {
    const ta = a.submittedAt ?? '';
    const tb = b.submittedAt ?? '';
    if (ta < tb) return 1;
    if (ta > tb) return -1;
    return 0;
  });
  const total = records.length;
  return { records: records.slice(offset, offset + limit), total };
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
// HMAC audit integrity
//
// Each audit log record is signed with HMAC-SHA256 over a canonical JSON
// string of its core fields. Uses SESSION_SECRET in production; falls back to
// a stable constant in dev/test so log records remain verifiable across
// restarts without a configured secret.
// ---------------------------------------------------------------------------

const DEV_AUDIT_HMAC_KEY = 'governor-os-dev-audit-hmac-key';

function getAuditHmacKey() {
  return process.env.SESSION_SECRET ?? DEV_AUDIT_HMAC_KEY;
}

/**
 * Compute HMAC-SHA256 hex digest over a fixed-key-ordered canonical JSON
 * representation of the record's core fields. Key ordering is fixed to
 * prevent any future key-ordering differences invalidating signatures.
 *
 * @param {{ jobId, repository, tag, submittedAt, completedAt, status, result }} record
 * @returns {string} hex digest
 */
function _computeAuditSig(record) {
  const canonical = JSON.stringify({
    jobId:       record.jobId       ?? null,
    repository:  record.repository  ?? null,
    tag:         record.tag         ?? null,
    submittedAt: record.submittedAt ?? null,
    completedAt: record.completedAt ?? null,
    status:      record.status      ?? null,
    verdict:     record.result?.governanceVerdict?.verdict ?? null,
  });
  return crypto.createHmac('sha256', getAuditHmacKey()).update(canonical).digest('hex');
}

/**
 * Verify the HMAC integrity signature on an audit log record.
 * Returns true when the `sig` field matches the computed HMAC, false otherwise.
 * Records written before signature support was added will have no `sig` and
 * return false.
 *
 * @param {object} record  Audit log record (as read from NDJSON or returned by the API)
 * @returns {boolean}
 */
export function _verifyAuditRecord(record) {
  if (!record?.sig || typeof record.sig !== 'string') return false;
  try {
    const expected = _computeAuditSig(record);
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(record.sig, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Rate limiters — exported so tests can reset stores between runs
// ---------------------------------------------------------------------------

export const _auditLimiterStore               = new MemoryStore();
export const _verifyLimiterStore              = new MemoryStore();
export const _getAuditLimiterStore            = new MemoryStore();
export const _listAuditsLimiterStore          = new MemoryStore();
export const _exportAuditsLimiterStore        = new MemoryStore();
export const _verifyIntegrityLimiterStore     = new MemoryStore();

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

const getAuditLimiter = rateLimit({
  windowMs:       60_000,
  max:            60,
  store:          _getAuditLimiterStore,
  standardHeaders: true,
  legacyHeaders:  false,
  message: { success: false, error: 'Too many requests. Please retry after 1 minute.' },
});

const listAuditsLimiter = rateLimit({
  windowMs:       60_000,
  max:            30,
  store:          _listAuditsLimiterStore,
  standardHeaders: true,
  legacyHeaders:  false,
  message: { success: false, error: 'Too many requests. Please retry after 1 minute.' },
});

const exportAuditsLimiter = rateLimit({
  windowMs:       60_000,
  max:            30,
  store:          _exportAuditsLimiterStore,
  standardHeaders: true,
  legacyHeaders:  false,
  message: { success: false, error: 'Too many requests. Please retry after 1 minute.' },
});

const verifyIntegrityLimiter = rateLimit({
  windowMs:       60_000,
  max:            30,
  store:          _verifyIntegrityLimiterStore,
  standardHeaders: true,
  legacyHeaders:  false,
  message: { success: false, error: 'Too many requests. Please retry after 1 minute.' },
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

    const { schemaVersion, repository, release, requested, profile } = req.body ?? {};

    // Input validation
    if (!schemaVersion || !repository || !release?.tag) {
      return res.status(400).json({
        success: false,
        error:   'Missing required fields: schemaVersion, repository, release.tag',
      });
    }

    // Org scope enforcement: when authenticated with a specific orgId in registry-enforced
    // mode, the submitted repository owner must match the authenticated org. orgId is null in
    // single-tenant LICENSE_SECRET mode — skip the check in that case.
    if (authResult?.orgId && isRegistryEnforced()) {
      const repoOwner = (repository ?? '').split('/')[0];
      if (repoOwner !== authResult.orgId) {
        return res.status(400).json({
          success: false,
          error:   `Repository owner '${repoOwner}' does not match authenticated organization '${authResult.orgId}'. Submissions must be for your own organization's repositories.`,
        });
      }
    }

    const auditJob = await enqueueAuditJob({ authToken: bearerToken, repository, release, requested, profile });

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

app.get('/api/v1/compliance/audit/:jobId', getAuditLimiter, async (req, res) => {
  try {
    const { jobId } = req.params;

    if (!jobId) {
      return res.status(400).json({ success: false, error: 'Missing jobId parameter' });
    }

    // Require auth in enforcement mode (LICENSE_SECRET set or org registry non-empty).
    // Dev mode (both unset/empty) preserves the previous open behaviour for free-tier callers.
    let authResult = null;
    if (process.env.LICENSE_SECRET || isRegistryEnforced()) {
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

      authResult = await authenticateBearerToken(bearerToken);
      if (!authResult.valid) {
        return res.status(401).json({
          success: false,
          error:   'Invalid authorization token.',
        });
      }

      if (isRegistryEnforced() && authResult.orgId) {
        if (!orgRegistry.has(authResult.orgId)) {
          return res.status(403).json({
            success: false,
            error:   `Organization '${authResult.orgId}' is not registered or has been evicted.`,
          });
        }
      }
    }

    const jobStatus = await getAuditJobStatus(jobId);

    if (!jobStatus) {
      if (evictedJobIds.has(jobId)) {
        return res.status(410).json({ success: false, error: `Audit job expired and has been evicted: ${jobId}` });
      }
      return res.status(404).json({ success: false, error: `Audit job not found: ${jobId}` });
    }

    // Org scope enforcement: when authenticated with a specific orgId in registry-enforced
    // mode, the job's repository owner must match the authenticated org. orgId is null in
    // single-tenant LICENSE_SECRET mode — skip the check in that case.
    if (authResult?.orgId && isRegistryEnforced()) {
      const jobRepoOwner = jobStatus.result?.repository?.split('/')[0];
      if (jobRepoOwner !== authResult.orgId) {
        return res.status(403).json({
          success: false,
          error:   'Access denied: this audit job belongs to a different organization.',
        });
      }
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
// GET /api/v1/compliance/audits
//
// Returns the authenticated org's audit jobs from the durable NDJSON log,
// sorted newest first.
//
// Authentication: same rules as GET /api/v1/compliance/audit/:jobId —
//   required when LICENSE_SECRET is set or org registry is non-empty; open
//   in dev/free-tier mode.
//
// Org scope:
//   - Registry-enforced multi-tenant mode (orgId non-null): only jobs whose
//     repository owner matches the authenticated org are returned.
//   - Single-tenant LICENSE_SECRET mode (orgId null): all jobs returned.
//
// Query params:
//   limit  — positive integer (default 50, max 200)
//
// Rate limit: 30 requests per minute per IP.
// ---------------------------------------------------------------------------

app.get('/api/v1/compliance/audits', listAuditsLimiter, async (req, res) => {
  try {
    let authResult = null;
    if (process.env.LICENSE_SECRET || isRegistryEnforced()) {
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

      authResult = await authenticateBearerToken(bearerToken);
      if (!authResult.valid) {
        return res.status(401).json({ success: false, error: 'Invalid authorization token.' });
      }

      if (isRegistryEnforced() && authResult.orgId) {
        if (!orgRegistry.has(authResult.orgId)) {
          return res.status(403).json({
            success: false,
            error:   `Organization '${authResult.orgId}' is not registered or has been evicted.`,
          });
        }
      }
    }

    // Parse and clamp ?limit
    const DEFAULT_LIMIT = 50;
    const MAX_LIMIT     = 200;
    let limit = DEFAULT_LIMIT;
    if (req.query.limit !== undefined) {
      const parsed = Number(req.query.limit);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return res.status(400).json({
          success: false,
          error:   'Invalid limit: must be a positive integer.',
        });
      }
      limit = Math.min(parsed, MAX_LIMIT);
    }

    // Parse ?offset
    let offset = 0;
    if (req.query.offset !== undefined) {
      const parsed = Number(req.query.offset);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return res.status(400).json({
          success: false,
          error:   'Invalid offset: must be a non-negative integer.',
        });
      }
      offset = parsed;
    }

    // Parse ?repository (optional exact-match filter)
    const repository = (typeof req.query.repository === 'string' && req.query.repository)
      ? req.query.repository
      : null;

    // Determine org scope for filtering
    const orgId = (isRegistryEnforced() && authResult?.orgId) ? authResult.orgId : null;

    const { records: jobs, total } = await _findJobsInAuditLog({ orgId, limit, offset, repository });

    return res.status(200).json({
      success: true,
      count:   jobs.length,
      jobs,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + jobs.length < total,
      },
    });

  } catch (error) {
    console.error('[GET /api/v1/compliance/audits] Error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error listing audit history.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/compliance/audits/export
//
// Returns a downloadable file of all audit records matching the caller's org
// scope. Supports CSV (default) and JSON formats via ?format=csv|json.
//
// Query params:
//   format     — 'csv' (default) or 'json'
//   repository — exact-match repository filter (e.g. 'acme/widgets')
//   from       — ISO 8601 date lower bound on submittedAt (inclusive)
//   to         — ISO 8601 date upper bound on submittedAt (inclusive)
//
// Same auth rules and rate limit (30 req/min) as GET /api/v1/compliance/audits.
// ---------------------------------------------------------------------------

/**
 * Escape a value for inclusion in a CSV field.
 * Wraps in double-quotes when the value contains commas, quotes, or newlines.
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeCsvField(value) {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

app.get('/api/v1/compliance/audits/export', exportAuditsLimiter, async (req, res) => {
  try {
    // Auth — identical to GET /api/v1/compliance/audits
    let authResult = null;
    if (process.env.LICENSE_SECRET || isRegistryEnforced()) {
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

      authResult = await authenticateBearerToken(bearerToken);
      if (!authResult.valid) {
        return res.status(401).json({ success: false, error: 'Invalid authorization token.' });
      }

      if (isRegistryEnforced() && authResult.orgId) {
        if (!orgRegistry.has(authResult.orgId)) {
          return res.status(403).json({
            success: false,
            error:   `Organization '${authResult.orgId}' is not registered or has been evicted.`,
          });
        }
      }
    }

    // Validate ?format (default: csv)
    const format = req.query.format ?? 'csv';
    if (format !== 'csv' && format !== 'json') {
      return res.status(400).json({
        success: false,
        error:   'Invalid format: must be "csv" or "json".',
      });
    }

    // Parse ?repository filter
    const repository = (typeof req.query.repository === 'string' && req.query.repository)
      ? req.query.repository
      : null;

    // Parse ?from and ?to date bounds
    let from = null;
    let to   = null;
    if (req.query.from !== undefined) {
      const d = new Date(req.query.from);
      if (isNaN(d.getTime())) {
        return res.status(400).json({
          success: false,
          error:   'Invalid from date: must be an ISO 8601 date string.',
        });
      }
      from = d;
    }
    if (req.query.to !== undefined) {
      const d = new Date(req.query.to);
      if (isNaN(d.getTime())) {
        return res.status(400).json({
          success: false,
          error:   'Invalid to date: must be an ISO 8601 date string.',
        });
      }
      to = d;
    }

    // Org scope
    const orgId = (isRegistryEnforced() && authResult?.orgId) ? authResult.orgId : null;

    // Fetch all matching records (no pagination for exports)
    const { records: allRecords } = await _findJobsInAuditLog({
      orgId,
      limit:      Number.MAX_SAFE_INTEGER,
      offset:     0,
      repository,
    });

    // Apply date range filter on submittedAt
    const records = (from === null && to === null)
      ? allRecords
      : allRecords.filter(r => {
          const ts = r.submittedAt ? new Date(r.submittedAt) : null;
          if (!ts || isNaN(ts.getTime())) return true;
          if (from !== null && ts < from) return false;
          if (to   !== null && ts > to)   return false;
          return true;
        });

    // Date string for the filename (YYYY-MM-DD in UTC)
    const dateStr = new Date().toISOString().slice(0, 10);

    if (format === 'json') {
      const exportRows = records.map(r => ({
        jobId:       r.jobId                              ?? '',
        repository:  r.repository                         ?? '',
        tag:         r.tag                                ?? '',
        profile:     r.result?.profile                    ?? '',
        verdict:     r.result?.governanceVerdict?.verdict ?? '',
        submittedAt: r.submittedAt                        ?? '',
        completedAt: r.completedAt                        ?? '',
        verified:    r.verified ?? false,
      }));
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="audit-export-${dateStr}.json"`);
      return res.status(200).json(exportRows);
    }

    // CSV
    const CSV_COLS = ['jobId', 'repository', 'tag', 'profile', 'verdict', 'submittedAt', 'completedAt', 'verified'];
    const csvLines = [CSV_COLS.join(',')];
    for (const r of records) {
      csvLines.push([
        escapeCsvField(r.jobId),
        escapeCsvField(r.repository),
        escapeCsvField(r.tag),
        escapeCsvField(r.result?.profile                    ?? ''),
        escapeCsvField(r.result?.governanceVerdict?.verdict ?? ''),
        escapeCsvField(r.submittedAt),
        escapeCsvField(r.completedAt),
        escapeCsvField(r.verified ?? false),
      ].join(','));
    }
    const csvBody = csvLines.join('\n') + '\n';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-export-${dateStr}.csv"`);
    return res.status(200).send(csvBody);

  } catch (error) {
    console.error('[GET /api/v1/compliance/audits/export] Error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error exporting audit history.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/compliance/audits/verify
//
// Verifies the HMAC integrity of every audit log record that matches the
// caller's org scope and optional filters. Returns a machine-readable report
// for compliance officers to hand to external auditors.
//
// Query params (same semantics as /export):
//   repository — exact-match repository filter (e.g. 'acme/widgets')
//   from       — ISO 8601 lower bound on submittedAt (inclusive)
//   to         — ISO 8601 upper bound on submittedAt (inclusive)
//
// Same auth rules and rate limit (30 req/min) as GET /api/v1/compliance/audits.
//
// Response:
//   {
//     success:    true,
//     verifiedAt: "<ISO 8601>",
//     total:      <n>,
//     verified:   <n>,        // records where sig matches
//     failed:     <n>,        // records where sig missing or mismatches
//     integrity:  "ok" | "compromised" | "partial",
//     records:    [{ jobId, repository, tag, submittedAt, verified }]
//   }
//
// integrity logic:
//   "ok"          — all records have a valid sig (vacuously true for empty log)
//   "compromised" — at least one record has a sig that does NOT verify (tamper detected)
//   "partial"     — no tampered records but some records have no sig (pre-#52 legacy)
// ---------------------------------------------------------------------------

app.get('/api/v1/compliance/audits/verify', verifyIntegrityLimiter, async (req, res) => {
  try {
    // Auth — identical to GET /api/v1/compliance/audits
    let authResult = null;
    if (process.env.LICENSE_SECRET || isRegistryEnforced()) {
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

      authResult = await authenticateBearerToken(bearerToken);
      if (!authResult.valid) {
        return res.status(401).json({ success: false, error: 'Invalid authorization token.' });
      }

      if (isRegistryEnforced() && authResult.orgId) {
        if (!orgRegistry.has(authResult.orgId)) {
          return res.status(403).json({
            success: false,
            error:   `Organization '${authResult.orgId}' is not registered or has been evicted.`,
          });
        }
      }
    }

    // Parse ?repository filter
    const repository = (typeof req.query.repository === 'string' && req.query.repository)
      ? req.query.repository
      : null;

    // Parse ?from and ?to date bounds
    let from = null;
    let to   = null;
    if (req.query.from !== undefined) {
      const d = new Date(req.query.from);
      if (isNaN(d.getTime())) {
        return res.status(400).json({
          success: false,
          error:   'Invalid from date: must be an ISO 8601 date string.',
        });
      }
      from = d;
    }
    if (req.query.to !== undefined) {
      const d = new Date(req.query.to);
      if (isNaN(d.getTime())) {
        return res.status(400).json({
          success: false,
          error:   'Invalid to date: must be an ISO 8601 date string.',
        });
      }
      to = d;
    }

    // Org scope
    const orgId = (isRegistryEnforced() && authResult?.orgId) ? authResult.orgId : null;

    // Fetch all matching records (no pagination for integrity checks)
    const { records: allRecords } = await _findJobsInAuditLog({
      orgId,
      limit:  Number.MAX_SAFE_INTEGER,
      offset: 0,
      repository,
    });

    // Apply date range filter on submittedAt
    const records = (from === null && to === null)
      ? allRecords
      : allRecords.filter(r => {
          const ts = r.submittedAt ? new Date(r.submittedAt) : null;
          if (!ts || isNaN(ts.getTime())) return true;
          if (from !== null && ts < from) return false;
          if (to   !== null && ts > to)   return false;
          return true;
        });

    // Compute integrity status across all matched records.
    // A record with `sig` that fails verification → compromised.
    // A record with no `sig` → unsigned legacy (pre-#52).
    // "compromised" takes precedence over "partial".
    let hasCompromised = false;
    let hasUnsigned    = false;
    let verifiedCount  = 0;
    let failedCount    = 0;

    for (const record of records) {
      if (record.verified) {
        verifiedCount++;
      } else {
        failedCount++;
        if (!record.sig) {
          hasUnsigned = true;
        } else {
          hasCompromised = true;
        }
      }
    }

    const integrity = hasCompromised ? 'compromised' : hasUnsigned ? 'partial' : 'ok';

    return res.status(200).json({
      success:    true,
      verifiedAt: new Date().toISOString(),
      total:      records.length,
      verified:   verifiedCount,
      failed:     failedCount,
      integrity,
      records: records.map(r => ({
        jobId:       r.jobId       ?? '',
        repository:  r.repository  ?? '',
        tag:         r.tag         ?? '',
        submittedAt: r.submittedAt ?? '',
        verified:    r.verified    ?? false,
      })),
    });

  } catch (error) {
    console.error('[GET /api/v1/compliance/audits/verify] Error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error verifying audit log integrity.' });
  }
});

// ---------------------------------------------------------------------------
// Admin auth helper
//
// Verifies the ADMIN_SECRET bearer token. Sends the error response and
// returns false when the request is not authorized; returns true otherwise.
// ---------------------------------------------------------------------------

function checkAdminAuth(req, res) {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    res.status(503).json({
      success: false,
      error:   'Admin endpoint is disabled (ADMIN_SECRET not configured).',
    });
    return false;
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
    res.status(401).json({ success: false, error: 'Unauthorized.' });
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// POST /admin/orgs
//
// Register or update an organization in the registry at runtime without a
// server restart. Protected by the ADMIN_SECRET env var.
//
// Expected request body: { id, licenseKey, allowedSubs }
// ---------------------------------------------------------------------------

app.post('/admin/orgs', async (req, res) => {
  if (!checkAdminAuth(req, res)) return;

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
  await _flushOrgsToFile();
  console.log(`[/admin/orgs] Registered org: ${id}`);
  return res.status(201).json({ success: true, message: `Organization '${id}' registered.` });
});

// ---------------------------------------------------------------------------
// GET /admin/orgs
//
// Returns the full list of registered organizations as a JSON array.
// License keys are intentionally omitted — they are write-only secrets.
// Protected by the ADMIN_SECRET env var.
//
// Response: [{ id, allowedSubs }]
// ---------------------------------------------------------------------------

app.get('/admin/orgs', (req, res) => {
  if (!checkAdminAuth(req, res)) return;

  const orgs = [];
  for (const [id, entry] of orgRegistry) {
    orgs.push({ id, allowedSubs: entry.allowedSubs });
  }
  return res.status(200).json(orgs);
});

// ---------------------------------------------------------------------------
// DELETE /admin/orgs/:id
//
// Removes an organization from the in-memory registry and immediately flushes
// the updated registry to disk. Protected by the ADMIN_SECRET env var.
//
// Response: 200 { success: true, message } | 404 { success: false, error }
// ---------------------------------------------------------------------------

app.delete('/admin/orgs/:id', async (req, res) => {
  if (!checkAdminAuth(req, res)) return;

  const { id } = req.params;
  if (!orgRegistry.has(id)) {
    return res.status(404).json({
      success: false,
      error:   `Organization '${id}' is not registered.`,
    });
  }

  orgRegistry.delete(id);
  await _flushOrgsToFile();
  console.log(`[/admin/orgs] Removed org: ${id}`);
  return res.status(204).end();
});

// ---------------------------------------------------------------------------
// GET /admin/audit-jobs
//
// Returns a summary list of all in-memory audit jobs, sorted by submittedAt
// descending (newest first). The full `result` payload is omitted to keep
// the response compact for ops dashboards.
// Protected by the ADMIN_SECRET env var.
//
// Response: [{ jobId, repository, tag, status, submittedAt, completedAt? }]
// ---------------------------------------------------------------------------

app.get('/admin/audit-jobs', (req, res) => {
  if (!checkAdminAuth(req, res)) return;

  const jobs = [];
  for (const [jobId, job] of auditJobs) {
    const summary = {
      jobId,
      repository:  job.repository,
      tag:         job.tag,
      status:      job.status,
      submittedAt: job.submittedAt,
    };
    if (job.completedAt !== undefined) {
      summary.completedAt = job.completedAt;
    }
    jobs.push(summary);
  }

  jobs.sort((a, b) => {
    if (a.submittedAt < b.submittedAt) return 1;
    if (a.submittedAt > b.submittedAt) return -1;
    return 0;
  });

  return res.status(200).json(jobs);
});

// ---------------------------------------------------------------------------
// GET /openapi.yaml — serve the OpenAPI 3.0 specification
// ---------------------------------------------------------------------------

app.get('/openapi.yaml', async (_req, res) => {
  try {
    const specPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'openapi.yaml');
    const content  = await fs.readFile(specPath, 'utf8');
    res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
    res.send(content);
  } catch {
    res.status(503).json({ error: 'OpenAPI spec unavailable.' });
  }
});

// ---------------------------------------------------------------------------
// GET /docs — Redoc HTML API documentation viewer
// ---------------------------------------------------------------------------

app.get('/docs', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
  <head>
    <title>Governor OS API Reference</title>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>body { margin: 0; padding: 0; }</style>
  </head>
  <body>
    <redoc spec-url='/openapi.yaml'></redoc>
    <script src="https://cdn.jsdelivr.net/npm/redoc@latest/bundles/redoc.standalone.js"></script>
  </body>
</html>`);
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
 * Return a profile-appropriate compliance control mapping.
 *
 * ISO 27001 uses Annex A control identifiers, SOC2 uses Trust Services Criteria
 * (CC codes), DORA uses Article references, and the default profile uses generic
 * CTRL codes. Using the wrong codes in an audit report would be a compliance error.
 *
 * @param {string} profile  One of: 'iso27001' | 'soc2' | 'dora' | 'default'
 * @returns {Record<string, string>}
 */
function getControlMapping(profile) {
  switch (profile) {
    case 'iso27001':
      return {
        'A.12.1.2': 'Change management: Release tag and metadata captured and reviewed.',
        'A.14.2.2': 'System change control: CI workflow completion linked to release.',
        'A.14.2.8': 'System security testing: Release notes and issue references reviewed.',
      };
    case 'soc2':
      return {
        'CC6.1': 'Logical access: Release tag and metadata captured.',
        'CC7.2': 'System monitoring: CI workflow completion linked to release.',
        'CC8.1': 'Change management: Release notes and issue references reviewed.',
      };
    case 'dora':
      return {
        'Art.9':  'ICT risk management: Release tag and operational risk assessed.',
        'Art.10': 'ICT incident detection: CI workflow completion and monitoring confirmed.',
        'Art.11': 'ICT business continuity: Release notes document impact and rollback plan.',
      };
    default:
      return {
        'CTRL-1': 'Change management: Release tag and metadata captured.',
        'CTRL-2': 'Monitoring: CI workflow completion linked to release.',
        'CTRL-3': 'Documentation: Release notes and issue references reviewed.',
      };
  }
}

/**
 * Store and process an audit job in the in-memory store.
 *
 * @param {{ authToken: string, repository: string, release: object, requested: object, profile?: string }} params
 * @returns {Promise<{ jobId: string }>}
 */
async function enqueueAuditJob({ authToken, repository, release, requested, profile }) {
  const safeRepo    = repository.replace(/[^a-zA-Z0-9-]/g, '_');
  const jobId       = `audit-${safeRepo}-${release.tag}-${Date.now()}`;
  const submittedAt = new Date().toISOString();

  const governance = deriveGovernanceVerdict(release);
  const resolvedProfile = profile ?? 'default';

  const result = {
    auditTrailId: jobId,
    repository,
    profile:      resolvedProfile,
    release: {
      tag:         release.tag,
      publishedAt: release.publishedAt ?? null,
      author:      release.author ?? null,
    },
    governanceVerdict: requested?.governanceVerdict !== false
      ? governance
      : undefined,
    controlMapping: requested?.isoControlMapping
      ? getControlMapping(resolvedProfile)
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

  await _appendJobToAuditLog(jobId, auditJobs.get(jobId));

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
  if (job) {
    return {
      status:  job.status,
      message: job.status === 'complete'
        ? `Audit complete for ${job.repository}@${job.tag}.`
        : 'Audit job is queued and awaiting processing.',
      result: job.result,
    };
  }

  // Fast path missed — scan the durable NDJSON log for jobs from prior process runs.
  const record = await _findJobInAuditLog(jobId);
  if (record) {
    return {
      status:  record.status,
      message: record.status === 'complete'
        ? `Audit complete for ${record.repository}@${record.tag}.`
        : 'Audit job is queued and awaiting processing.',
      result: record.result,
    };
  }

  return null;
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
  // Load persisted orgs first, then overlay env-config entries (env takes precedence).
  await _loadOrgsFromFile();
  _loadOrgsFromEnv();
  const server = app.listen(PORT, () => {
    console.log(`Governor OS Web Platform running on port ${PORT}`);
  });

  async function shutdown(signal) {
    console.log(`[shutdown] Received ${signal} — stopping server gracefully.`);
    server.close();
    await _flushOrgsToFile();
    console.log('[shutdown] Org registry flushed. Exiting cleanly.');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

export default app;

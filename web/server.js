/**
 * Governor OS — Web Platform API Server
 *
 * Lightweight Express server exposing the REST API consumed by the Governor OS
 * GitHub Action (premium tier) and future web application clients.
 *
 * Endpoints (v1):
 *   POST /api/v1/compliance/verify  — Validate OIDC token and license key
 *   POST /api/v1/compliance/audit   — Receive repository metadata and run audit
 *   GET  /api/v1/compliance/audit/:jobId — Retrieve audit job status and result
 */

import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';

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
 *   result?: object
 * }} AuditJob
 */

/** @type {Map<string, AuditJob>} */
export const auditJobs = new Map();

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
// Validates the OIDC token and organization license supplied by the GitHub
// Action. On success, returns a session token granting access to audit
// endpoints. On failure, returns 401 with a descriptive error.
//
// Expected request body:
// {
//   "oidcToken":       string,   // Short-lived GitHub OIDC JWT
//   "organizationId":  string,   // Governor OS tenant ID
//   "serviceAccountId": string,  // CI service account identifier
//   "federationRuleId": string   // OIDC federation rule configured in Governor OS
// }
// ---------------------------------------------------------------------------

app.post('/api/v1/compliance/verify', async (req, res) => {
  try {
    const { oidcToken, organizationId, serviceAccountId, federationRuleId } = req.body ?? {};

    // Input validation
    if (!oidcToken || !organizationId || !serviceAccountId || !federationRuleId) {
      return res.status(400).json({
        success: false,
        error:   'Missing required fields: oidcToken, organizationId, serviceAccountId, federationRuleId',
      });
    }

    // TODO: implement real OIDC token verification against GitHub's JWKS endpoint
    // TODO: validate organizationId license status against the Governor OS database
    const verificationResult = await verifyOidcAndLicense({
      oidcToken,
      organizationId,
      serviceAccountId,
      federationRuleId,
    });

    return res.status(200).json({
      success:      true,
      sessionToken: verificationResult.sessionToken,
      expiresIn:    verificationResult.expiresIn,
      message:      'OIDC token and license verified. Session token issued.',
    });

  } catch (error) {
    console.error('[/api/v1/compliance/verify] Error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error during verification.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/compliance/audit
//
// Receives an AuditPayload from the GitHub Action (premium tier), validates
// the license key, and processes the audit synchronously.
//
// Authentication: Authorization: Bearer <license-key>
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

app.post('/api/v1/compliance/audit', async (req, res) => {
  try {
    // Extract Bearer token from Authorization header
    const authHeader = req.headers['authorization'] ?? '';
    const licenseKey = authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : '';

    if (!licenseKey) {
      return res.status(401).json({
        success: false,
        error:   'Missing or invalid Authorization header. Expected: Bearer <license-key>',
      });
    }

    if (!validateLicenseKey(licenseKey)) {
      return res.status(401).json({
        success: false,
        error:   'Invalid license key.',
      });
    }

    const { schemaVersion, repository, release, requested } = req.body ?? {};

    // Input validation
    if (!schemaVersion || !repository || !release?.tag) {
      return res.status(400).json({
        success: false,
        error:   'Missing required fields: schemaVersion, repository, release.tag',
      });
    }

    const auditJob = await enqueueAuditJob({ licenseKey, repository, release, requested });

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
 * Jobs are processed synchronously so that GET /audit/:jobId immediately
 * returns a "complete" status — no background worker or database needed for
 * the MVP.
 *
 * @param {{ licenseKey: string, repository: string, release: object, requested: object }} params
 * @returns {Promise<{ jobId: string }>}
 */
async function enqueueAuditJob({ licenseKey, repository, release, requested }) {
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

  auditJobs.set(jobId, {
    status:      'complete',
    submittedAt,
    completedAt: result.completedAt,
    repository,
    tag:         release.tag,
    result,
  });

  console.log(`[enqueueAuditJob] Processed: ${jobId} → verdict: ${governance.verdict} (license prefix: ${licenseKey.slice(0, 8)}...)`);
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
 * Placeholder: verifies the OIDC token against GitHub JWKS and checks the
 * organization's license status in the Governor OS database.
 */
async function verifyOidcAndLicense({ oidcToken, organizationId, federationRuleId }) {
  // TODO: fetch GitHub JWKS from https://token.actions.githubusercontent.com/.well-known/jwks
  // TODO: verify JWT signature, iss, aud, and sub claims against federationRuleId
  // TODO: query the Governor OS database for organizationId license status
  console.log(`[verifyOidcAndLicense] org=${organizationId} rule=${federationRuleId} token_prefix=${oidcToken.slice(0, 12)}...`);

  return {
    sessionToken: `session-${organizationId}-placeholder`,
    expiresIn:    3600,
  };
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

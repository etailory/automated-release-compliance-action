/**
 * Governor OS — Web Platform API Server
 *
 * Lightweight Express server exposing the REST API consumed by the Governor OS
 * GitHub Action (premium tier) and future web application clients.
 *
 * Endpoints (v1):
 *   POST /api/v1/compliance/verify  — Validate OIDC token and license key
 *   POST /api/v1/compliance/audit   — Receive repository metadata and trigger audit generation
 */

import express from 'express';

const app  = express();
const PORT = process.env.PORT ?? 3000;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(express.json());

// Basic request logger — replace with a structured logger (e.g. pino) in production
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
// Receives an AuditPayload from the GitHub Action (premium tier) and enqueues
// an automated compliance audit trail generation job.
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

    const { schemaVersion, repository, release } = req.body ?? {};

    // Input validation
    if (!schemaVersion || !repository || !release?.tag) {
      return res.status(400).json({
        success: false,
        error:   'Missing required fields: schemaVersion, repository, release.tag',
      });
    }

    // TODO: validate license key against the Governor OS database
    // TODO: persist audit request to the Governor OS database
    // TODO: enqueue an AI audit generation job (e.g. via BullMQ, SQS, Cloud Tasks)
    const auditJob = await enqueueAuditJob({ licenseKey, repository, release });

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
// Returns the current status of a compliance audit job. The GitHub Action
// polls this endpoint after submitting via POST until the job leaves the
// "queued" state.
//
// Response: { success, jobId, status: "queued" | "running" | "complete" | "failed" }
// ---------------------------------------------------------------------------

app.get('/api/v1/compliance/audit/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;

    if (!jobId) {
      return res.status(400).json({ success: false, error: 'Missing jobId parameter' });
    }

    // TODO: look up the real job status from the Governor OS database / queue
    const jobStatus = await getAuditJobStatus(jobId);

    return res.status(200).json({
      success: true,
      jobId,
      status:  jobStatus.status,
      message: jobStatus.message,
    });

  } catch (error) {
    console.error('[GET /api/v1/compliance/audit/:jobId] Error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error fetching job status.' });
  }
});

// ---------------------------------------------------------------------------
// Placeholder service functions
// (Replace these with real implementations as the platform evolves)
// ---------------------------------------------------------------------------

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

/**
 * Placeholder: persists release metadata and enqueues an AI-driven audit
 * trail generation job for the given repository and release.
 */
async function enqueueAuditJob({ licenseKey, repository, release }) {
  // TODO: insert audit job record into the Governor OS database
  // TODO: publish a job message to the audit queue (e.g. BullMQ, SQS, Cloud Tasks)
  const safeRepo = repository.replace(/[^a-zA-Z0-9-]/g, '_');
  const jobId = `audit-${safeRepo}-${release.tag}-${Date.now()}`;
  console.log(`[enqueueAuditJob] Queued job: ${jobId} (license prefix: ${licenseKey.slice(0, 8)}...)`);

  return { jobId };
}

/**
 * Placeholder: fetches the current status of an audit job.
 */
async function getAuditJobStatus(jobId) {
  // TODO: query job status from the Governor OS database / task queue
  console.log(`[getAuditJobStatus] Checking status for: ${jobId}`);

  return { status: 'queued', message: 'Audit job is queued and awaiting processing.' };
}

// ---------------------------------------------------------------------------
// 404 fallback
// ---------------------------------------------------------------------------

app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Governor OS Web Platform running on port ${PORT}`);
});

export default app;

"use strict";

/**
 * Premium-tier bridge (STUB).
 *
 * In the free tier this module is never invoked. When a `license-key` input is
 * supplied, `runPremiumAudit` is called as a placeholder for the future hosted
 * backend that will perform AI-driven ISO/SOC2/DORA auditing, evidence
 * generation, and hard governance blocking.
 *
 * IMPORTANT: This stub deliberately does NOT send any data off the runner yet.
 * It only shapes and validates the payload so the integration contract is
 * stable before the backend exists. Replace `dispatchToBackend` with a real
 * authenticated HTTPS call when the SaaS endpoint is live.
 */

/** Where the hosted audit backend will eventually live. */
const BACKEND_ENDPOINT =
  process.env.COMPLIANCE_BACKEND_URL || "https://api.example-compliance.dev/v1/audits";

/**
 * Build the (future) request payload from the release context.
 * Kept pure and side-effect free so it is easy to unit test.
 * @param {object} release   Normalized release info.
 * @param {object} repo      { owner, repo }.
 * @returns {object}
 */
function buildAuditPayload(release, repo) {
  return {
    schemaVersion: "1.0",
    repository: `${repo.owner}/${repo.repo}`,
    release: {
      tag: release.tag,
      name: release.name,
      isPrerelease: release.isPrerelease,
      isDraft: release.isDraft,
      publishedAt: release.publishedAt,
      author: release.author,
    },
    // The real backend will fan out to fetch the commits/PRs in the range and
    // run the Claude-powered ISO control-mapping analysis server-side.
    requested: {
      isoControlMapping: true,
      evidencePdf: true,
      governanceVerdict: true,
    },
  };
}

/**
 * Placeholder dispatch. Intentionally a no-op network call for the MVP.
 * @param {string} licenseKey
 * @param {object} payload
 * @returns {Promise<{status: string, queued: boolean}>}
 */
async function dispatchToBackend(licenseKey, payload) {
  // TODO: replace with an authenticated fetch() to BACKEND_ENDPOINT.
  //   await fetch(BACKEND_ENDPOINT, {
  //     method: "POST",
  //     headers: {
  //       "content-type": "application/json",
  //       authorization: `Bearer ${licenseKey}`,
  //     },
  //     body: JSON.stringify(payload),
  //   });
  return { status: "stubbed", queued: false };
}

/**
 * Premium entry point. Prepares the secure bridge; does not yet transmit data.
 * @param {object} args
 * @param {string} args.licenseKey
 * @param {object} args.release
 * @param {object} args.repo
 * @param {object} args.logger     Minimal logger ({ info, warning, debug }).
 * @returns {Promise<{ prepared: boolean, endpoint: string, payload: object }>}
 */
async function runPremiumAudit({ licenseKey, release, repo, logger }) {
  if (!licenseKey) {
    throw new Error("runPremiumAudit called without a license key");
  }

  logger.info("Premium tier detected — preparing secure compliance bridge.");
  const payload = buildAuditPayload(release, repo);

  logger.debug(`Prepared audit payload for ${payload.repository}@${release.tag}`);
  logger.info(
    `Bridge target: ${BACKEND_ENDPOINT} (transmission is stubbed in the MVP — no data leaves the runner yet).`
  );

  const result = await dispatchToBackend(licenseKey, payload);
  logger.info(`Backend dispatch result: ${result.status}.`);

  return { prepared: true, endpoint: BACKEND_ENDPOINT, payload };
}

module.exports = { runPremiumAudit, buildAuditPayload, dispatchToBackend, BACKEND_ENDPOINT };

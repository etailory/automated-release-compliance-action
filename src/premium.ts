/**
 * Premium-tier bridge (STUB).
 *
 * In the free tier this module is never invoked. When a `license-key` input is
 * supplied, `runPremiumAudit` is called as a placeholder for the future hosted
 * backend that will perform AI-driven ISO/SOC2/DORA auditing, evidence
 * generation, and hard governance blocking.
 *
 * IMPORTANT: This stub deliberately does NOT send any data off the runner yet.
 * Replace `dispatchToBackend` with a real authenticated HTTPS call when the
 * SaaS endpoint is live.
 */

import type {
  Release,
  Repo,
  Logger,
  AuditPayload,
  DispatchResult,
  PremiumAuditResult,
} from "./types.js";

/** Where the hosted audit backend will eventually live. */
export const BACKEND_ENDPOINT: string =
  process.env.COMPLIANCE_BACKEND_URL || "https://api.example-compliance.dev/v1/audits";

/**
 * Build the (future) request payload from the release context.
 */
export function buildAuditPayload(release: Release, repo: Repo): AuditPayload {
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
    requested: {
      isoControlMapping: true,
      evidencePdf: true,
      governanceVerdict: true,
    },
  };
}

/**
 * Placeholder dispatch — intentionally a no-op for the MVP.
 */
export async function dispatchToBackend(
  _licenseKey: string,
  _payload: AuditPayload
): Promise<DispatchResult> {
  // TODO: replace with an authenticated fetch() to BACKEND_ENDPOINT.
  return { status: "stubbed", queued: false };
}

/**
 * Premium entry point. Prepares the secure bridge; does not yet transmit data.
 */
export async function runPremiumAudit({
  licenseKey,
  release,
  repo,
  logger,
}: {
  licenseKey: string;
  release: Release;
  repo: Repo;
  logger: Logger;
}): Promise<PremiumAuditResult> {
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

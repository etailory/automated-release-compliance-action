/**
 * Premium-tier bridge.
 *
 * In the free tier this module is never invoked. When a `license-key` input is
 * supplied, `runPremiumAudit` dispatches an authenticated HTTPS POST to the
 * Governor OS backend, which enqueues an AI-driven ISO/SOC2/DORA audit job.
 *
 * Set COMPLIANCE_BACKEND_URL to enable real dispatch. Without it, the bridge
 * logs a warning and skips transmission so free-tier CI runs are unaffected.
 */

import type {
  Release,
  Repo,
  Logger,
  AuditPayload,
  DispatchResult,
  PremiumAuditResult,
} from "./types.js";

const AUDIT_PATH = "/api/v1/compliance/audit";
const DEFAULT_TIMEOUT_MS = 10_000;

/** Returns the full audit endpoint URL, or null if COMPLIANCE_BACKEND_URL is unset. */
export function getAuditEndpoint(): string | null {
  const base = process.env.COMPLIANCE_BACKEND_URL?.replace(/\/$/, "");
  return base ? `${base}${AUDIT_PATH}` : null;
}

/** Exported for backward compatibility and logging. */
export const BACKEND_ENDPOINT: string =
  (process.env.COMPLIANCE_BACKEND_URL?.replace(/\/$/, "") ??
    "https://api.example-compliance.dev") + AUDIT_PATH;

/**
 * Build the request payload from the release context.
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
 * Dispatch an audit payload to the backend.
 *
 * Returns `{ status: "stubbed", queued: false }` when COMPLIANCE_BACKEND_URL
 * is not set. On HTTP 202 returns the jobId from the backend. On any other
 * HTTP status throws a descriptive error so the caller can surface it.
 */
export async function dispatchToBackend(
  licenseKey: string,
  payload: AuditPayload
): Promise<DispatchResult> {
  const base = process.env.COMPLIANCE_BACKEND_URL?.replace(/\/$/, "");
  if (!base) {
    return { status: "stubbed", queued: false };
  }

  const endpoint = `${base}${AUDIT_PATH}`;
  const timeoutMs = Number(
    process.env.COMPLIANCE_REQUEST_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${licenseKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (response.status === 202) {
      const data = (await response.json()) as { jobId?: string };
      return { status: "queued", queued: true, jobId: data.jobId };
    }

    let detail: string;
    try {
      detail = await response.text();
    } catch {
      detail = "(unreadable response body)";
    }
    throw new Error(
      `Compliance backend returned HTTP ${response.status}: ${detail}`
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Premium entry point. Builds the audit payload and dispatches it to the
 * backend. Logs the jobId so it appears in the Action summary.
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

  const endpoint = getAuditEndpoint();
  logger.info("Premium tier detected — initiating compliance audit.");
  const payload = buildAuditPayload(release, repo);
  logger.debug(`Prepared audit payload for ${payload.repository}@${release.tag}`);

  if (!endpoint) {
    logger.warning(
      "COMPLIANCE_BACKEND_URL is not set — premium audit skipped. " +
        "Set this variable to enable backend auditing."
    );
    return {
      prepared: true,
      endpoint:
        "https://api.example-compliance.dev" + AUDIT_PATH,
      payload,
    };
  }

  logger.info(`Dispatching audit to ${endpoint}`);
  const result = await dispatchToBackend(licenseKey, payload);
  logger.info(`Backend dispatch result: ${result.status}.`);

  if (result.jobId) {
    logger.info(`Compliance audit job queued: jobId=${result.jobId}`);
  }

  return { prepared: true, endpoint, payload, jobId: result.jobId };
}

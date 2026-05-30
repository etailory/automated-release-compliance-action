/**
 * Governor OS — Release Compliance Action
 *
 * Entry point for the GitHub Action runtime. Reads the triggering GitHub Release
 * event and routes execution to the appropriate compliance tier:
 *
 *   Free Tier   — Local log-based verification of release note completeness.
 *   Premium     — OIDC-authenticated payload forwarded to the Governor OS web
 *                 platform for full audit trail generation.
 */

import * as core from '@actions/core';
import * as github from '@actions/github';

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function run() {
  try {
    const token = core.getInput('github-token', { required: true });

    // Optional premium OIDC inputs — presence determines execution tier
    const federationRuleId = core.getInput('anthropic-federation-rule-id');
    const organizationId   = core.getInput('anthropic-organization-id');
    const serviceAccountId = core.getInput('anthropic-service-account-id');

    const isPremium = Boolean(federationRuleId && organizationId && serviceAccountId);

    // Extract release context from the triggering event payload
    const releaseContext = extractReleaseContext(github.context);

    if (!releaseContext) {
      core.setFailed(
        'This action must be triggered by a GitHub Release event. ' +
        'Ensure your workflow uses "on: release: types: [published]".'
      );
      return;
    }

    core.info(`Compliance check initiated for release: ${releaseContext.tagName}`);

    if (isPremium) {
      await runPremiumOidcBranch(releaseContext, {
        federationRuleId,
        organizationId,
        serviceAccountId,
      });
    } else {
      await runFreeTierBranch(releaseContext);
    }

  } catch (error) {
    core.setFailed(`Governor OS Compliance Action failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Context extraction
// ---------------------------------------------------------------------------

/**
 * Pulls the relevant fields from the GitHub release event payload.
 * Returns null if the workflow was not triggered by a release event.
 */
function extractReleaseContext(context) {
  if (context.eventName !== 'release') {
    return null;
  }

  const { payload, repo } = context;
  const release = payload.release;

  return {
    tagName:     release.tag_name,
    name:        release.name,
    body:        release.body ?? '',
    isDraft:     release.draft,
    isPrerelease: release.prerelease,
    htmlUrl:     release.html_url,
    author:      release.author?.login ?? 'unknown',
    owner:       repo.owner,
    repository:  repo.repo,
    publishedAt: release.published_at,
  };
}

// ---------------------------------------------------------------------------
// FREE TIER — Local compliance verification
// ---------------------------------------------------------------------------

/**
 * Performs a lightweight, local verification of release note completeness.
 * Checks that the release body contains expected compliance sections and
 * logs a structured compliance report. No external network calls are made.
 */
async function runFreeTierBranch(releaseContext) {
  core.startGroup('Governor OS — Free Tier Compliance Verification');

  const { tagName, name, body, author, htmlUrl } = releaseContext;

  core.info('--- Release Metadata ---');
  core.info(`Tag:        ${tagName}`);
  core.info(`Name:       ${name || '(no name)'}`);
  core.info(`Author:     ${author}`);
  core.info(`URL:        ${htmlUrl}`);
  core.info('');
  core.info('--- Compliance Checks ---');

  const checks = verifyReleaseNoteCompliance(body);
  let allPassed = true;

  for (const check of checks) {
    if (check.passed) {
      core.info(`✔  ${check.label}`);
    } else {
      core.warning(`✘  ${check.label} — ${check.hint}`);
      allPassed = false;
    }
  }

  core.info('');

  if (allPassed) {
    core.info('✅ Release note compliance verified. All required sections present.');
  } else {
    // Warn rather than fail — free tier is advisory only
    core.warning(
      '⚠️  One or more compliance checks failed. ' +
      'Upgrade to Governor OS Premium for automated remediation and full audit trails.'
    );
  }

  core.endGroup();
}

/**
 * Evaluates the release body against a set of compliance heuristics.
 * Returns an array of check result objects.
 */
function verifyReleaseNoteCompliance(body) {
  const lower = body.toLowerCase();

  return [
    {
      label:  'Release body is non-empty',
      passed: body.trim().length > 0,
      hint:   'Add a description of what changed in this release.',
    },
    {
      label:  'Changes / What\'s Changed section present',
      passed: /what'?s changed|change\s*log|changes:/i.test(body),
      hint:   'Include a "What\'s Changed" or "Changelog" section.',
    },
    {
      label:  'Breaking changes flagged (if applicable)',
      passed: /breaking|migration|upgrade guide/i.test(lower) || body.trim().length < 200,
      hint:   'For significant releases, document breaking changes or migration steps.',
    },
    {
      label:  'Security notes present (if applicable)',
      passed: /security|cve|vulnerability|patch/i.test(lower) || body.trim().length < 200,
      hint:   'If this release addresses security issues, document them explicitly.',
    },
    {
      label:  'Minimum body length (80 chars)',
      passed: body.trim().length >= 80,
      hint:   'Release notes should be at least 80 characters to be meaningful.',
    },
  ];
}

// ---------------------------------------------------------------------------
// PREMIUM — OIDC-authenticated audit via Governor OS Web Platform
// ---------------------------------------------------------------------------

/**
 * Exchanges OIDC credentials for a short-lived token, then forwards the
 * full release payload to the Governor OS web platform for:
 *   - License / OIDC key validation  (/api/v1/compliance/verify)
 *   - Automated audit trail generation (/api/v1/compliance/audit)
 *
 * NOTE: This is a scaffold. The OIDC exchange and API base URL are
 * placeholders pending the Governor OS web platform deployment.
 */
async function runPremiumOidcBranch(releaseContext, oidcConfig) {
  core.startGroup('Governor OS — Premium OIDC Compliance Verification');

  const { federationRuleId, organizationId, serviceAccountId } = oidcConfig;

  core.info('OIDC premium branch activated.');
  core.info(`Organization:    ${organizationId}`);
  core.info(`Service Account: ${serviceAccountId}`);
  core.info(`Federation Rule: ${federationRuleId}`);
  core.info('');

  // Step 1 — Obtain a short-lived OIDC token from GitHub's token endpoint.
  // The Governor OS platform will verify this token against the federation
  // rule to confirm the caller is a trusted CI principal.
  const oidcToken = await obtainOidcToken(federationRuleId);

  // Step 2 — Build the authenticated payload to send to the web platform
  const payload = buildAuditPayload(releaseContext, oidcConfig, oidcToken);

  // Step 3 — POST to /api/v1/compliance/verify (validates OIDC + license)
  await forwardToWebPlatform('/api/v1/compliance/verify', payload);

  // Step 4 — POST to /api/v1/compliance/audit (triggers audit trail generation)
  await forwardToWebPlatform('/api/v1/compliance/audit', payload);

  core.info('');
  core.info('✅ Premium compliance audit submitted to Governor OS platform.');
  core.endGroup();
}

/**
 * Placeholder: obtains an OIDC token from GitHub Actions' token endpoint.
 * Will be replaced with actual core.getIDToken() call once the audience
 * (Governor OS platform URL) is confirmed.
 */
async function obtainOidcToken(federationRuleId) {
  // TODO: replace audience string with the production Governor OS platform URL
  // const token = await core.getIDToken('https://app.governor-os.io');
  core.info(`[PLACEHOLDER] Requesting OIDC token for federation rule: ${federationRuleId}`);
  return 'oidc-token-placeholder';
}

/**
 * Builds the structured payload forwarded to the Governor OS web platform.
 */
function buildAuditPayload(releaseContext, oidcConfig, oidcToken) {
  return {
    oidcToken,
    organizationId:   oidcConfig.organizationId,
    serviceAccountId: oidcConfig.serviceAccountId,
    federationRuleId: oidcConfig.federationRuleId,
    release: releaseContext,
  };
}

/**
 * Placeholder: forwards a JSON payload to the Governor OS web platform.
 * Will be replaced with an authenticated fetch() call once the platform
 * base URL is available via action input or environment variable.
 */
async function forwardToWebPlatform(endpoint, payload) {
  // TODO: replace with actual fetch() call once WEB_PLATFORM_BASE_URL is set
  // const baseUrl = core.getInput('governor-os-api-url') || process.env.GOVERNOR_OS_API_URL;
  // const response = await fetch(`${baseUrl}${endpoint}`, {
  //   method: 'POST',
  //   headers: {
  //     'Content-Type': 'application/json',
  //     'Authorization': `Bearer ${payload.oidcToken}`,
  //   },
  //   body: JSON.stringify(payload),
  // });
  core.info(`[PLACEHOLDER] POST ${endpoint} — payload size: ${JSON.stringify(payload).length} bytes`);
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

run();

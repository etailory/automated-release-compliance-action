/**
 * Free-tier audit evidence.
 *
 * Governor OS's core promise is a durable, end-to-end audit trail. This module
 * turns an in-memory checklist evaluation into a schema-versioned, machine-readable
 * {@link ComplianceReport} that can be written to disk and archived as a CI artifact
 * — the first concrete, deployable piece of that audit trail.
 *
 * The builder is intentionally **pure**: it takes the timestamp as an argument
 * rather than reading the clock, so reports are deterministic and easy to test.
 * Side effects (writing the file) live in the action entry point.
 */

import type {
  CommitMetadata,
  ComplianceProfile,
  ComplianceReport,
  EvaluateResult,
  Release,
  Repo,
} from "./types.js";

/** Version of the {@link ComplianceReport} schema. Bump on breaking shape changes. */
export const REPORT_SCHEMA_VERSION = "1.0";

/** Identifies the tool that produced a report. */
export const TOOL_NAME = "automated-release-compliance-action";

/** Tool version; keep in sync with `package.json`. */
export const TOOL_VERSION = "0.1.0";

/**
 * Build a structured compliance report from a checklist evaluation.
 *
 * @param params.release      Normalized release under evaluation.
 * @param params.repo         The `owner`/`repo` the release belongs to.
 * @param params.evaluation   Result of {@link evaluateChecklist}.
 * @param params.tier         Which tier produced the evaluation.
 * @param params.generatedAt  ISO-8601 timestamp; injected for determinism.
 */
export function buildComplianceReport(params: {
  release: Release;
  repo: Repo;
  evaluation: EvaluateResult;
  tier: "free" | "premium";
  profile: ComplianceProfile;
  generatedAt: string;
  commits?: CommitMetadata;
}): ComplianceReport {
  const { release, repo, evaluation, tier, profile, generatedAt, commits } = params;

  const report: ComplianceReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    tier,
    profile,
    repository: `${repo.owner}/${repo.repo}`,
    release: {
      tag: release.tag,
      name: release.name,
      isPrerelease: release.isPrerelease,
      isDraft: release.isDraft,
      publishedAt: release.publishedAt,
      author: release.author,
      url: release.url,
    },
    compliance: {
      passed: evaluation.passed,
      score: evaluation.score,
      total: evaluation.total,
      // Deep-copy each check so the report is a standalone snapshot, not a live reference.
      checks: evaluation.results.map((r) => ({
        ...r,
        ...(r.evidence ? { evidence: [...r.evidence] } : {}),
      })),
    },
  };

  if (commits) {
    report.commits = {
      count: commits.count,
      authors: [...commits.authors],
      shas: [...commits.shas],
    };
  }

  return report;
}

/**
 * Serialize a report to stable, pretty-printed JSON with a trailing newline
 * (so the file is diff- and POSIX-friendly).
 */
export function serializeReport(report: ComplianceReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import * as core from "@actions/core";
import * as github from "@actions/github";

import { fetchReleaseCommits } from "./commits.js";
import { parseReleaseFromContext } from "./context.js";
import { evaluateChecklist, getRulesForProfile } from "./checklist.js";
import { runPremiumAudit } from "./premium.js";
import { buildComplianceReport, computeReportHash, serializeReport } from "./report.js";
import { buildJobSummary } from "./summary.js";
import { buildFailureMessage } from "./messages.js";
import type { ActionContext, CommitMetadata, Release, Repo, EvaluateResult, ComplianceProfile, Logger } from "./types.js";

export { parseReleaseFromContext, buildFailureMessage };

/** Render the free-tier checklist results to the GitHub job summary + log. */
async function reportFreeTier(
  repo: Repo,
  release: Release,
  evaluation: EvaluateResult,
  profile: ComplianceProfile,
  tier: "free" | "premium",
  generatedAt: string,
  reportPath?: string,
  integrityHash?: string
): Promise<void> {
  core.info("─".repeat(60));
  core.info(`Release compliance check — ${release.name} (${release.tag})`);
  core.info(`Profile: ${profile} | Result: ${evaluation.score}/${evaluation.total} checks passed`);

  for (const item of evaluation.results) {
    const mark = item.ok ? "✅" : "❌";
    core.info(`  ${mark} ${item.label}`);
  }
  core.info("─".repeat(60));

  try {
    await buildJobSummary(
      { repo, release, evaluation, profile, tier, generatedAt, reportPath, integrityHash },
      core.summary
    );
  } catch (err) {
    // Summary is best-effort (e.g. unavailable in some runners); never fail on it.
    core.debug(`Could not write job summary: ${(err as Error).message}`);
  }
}

const VALID_PROFILES: ComplianceProfile[] = ["default", "iso27001", "soc2", "dora"];

/**
 * Write a durable, machine-readable compliance report to disk so it can be
 * archived as audit evidence (e.g. a CI artifact). Embeds a SHA-256 integrity
 * hash before writing. Returns the hex hash so callers can surface it in the
 * job summary. Because the user explicitly requested a report path, an I/O
 * failure here is treated as a hard failure rather than swallowed.
 */
function writeComplianceReport(
  reportPath: string,
  release: Release,
  repo: Repo,
  evaluation: EvaluateResult,
  tier: "free" | "premium",
  generatedAt: string,
  commits?: CommitMetadata,
  profile: ComplianceProfile = "default"
): string {
  const report = buildComplianceReport({
    release,
    repo,
    evaluation,
    tier,
    profile,
    generatedAt,
    commits,
  });

  report.integrityHash = computeReportHash(report);

  const dir = dirname(reportPath);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(reportPath, serializeReport(report), "utf8");

  core.info(`Wrote compliance report to ${reportPath}`);
  core.setOutput("report-path", reportPath);
  return report.integrityHash;
}

export async function run(): Promise<void> {
  try {
    const token = core.getInput("github-token", { required: true });
    const licenseKey = core.getInput("license-key");
    const failOnIncomplete = core.getBooleanInput("fail-on-incomplete");
    const rawProfile = core.getInput("compliance-profile").trim().toLowerCase();
    if (rawProfile && !(VALID_PROFILES as string[]).includes(rawProfile)) {
      core.setFailed(
        `Unknown compliance-profile "${rawProfile}". Valid values: ${VALID_PROFILES.join(", ")}.`
      );
      return;
    }
    const profile: ComplianceProfile = (VALID_PROFILES as string[]).includes(rawProfile)
      ? (rawProfile as ComplianceProfile)
      : "default";
    const reportPath = core.getInput("report-path");

    const context = github.context as ActionContext;
    const { release, body } = parseReleaseFromContext(context);

    if (!release) {
      core.warning(
        "No release or tag found in the event payload. This action is intended to run on 'release' (published) or tag 'push' events."
      );
      core.setOutput("passed", "false");
      core.setOutput("score", "0");
      core.setOutput("tier", licenseKey ? "premium" : "free");
      core.setOutput("profile", profile);
      return;
    }

    // --- Free tier: always runs, fully local. ---------------------------------
    const repo = context.repo ?? { owner: "", repo: "" };
    const tier = licenseKey ? "premium" : "free";
    const rules = getRulesForProfile(profile);
    const evaluation = evaluateChecklist(body, { release }, rules);
    const generatedAt = new Date().toISOString();

    // --- Commit metadata enrichment: best-effort, release events only. --------
    // Fetched before the summary so the hash (which covers commits) matches the
    // report file and can be shown in the job summary.
    let commits: CommitMetadata | undefined;
    if (context.payload.release) {
      const octokit = github.getOctokit(token);
      const logger: Logger = {
        info: (m: string) => core.info(m),
        warning: (m: string) => core.warning(m),
        debug: (m: string) => core.debug(m),
      };
      commits = await fetchReleaseCommits(octokit as never, repo, release.tag, logger);
      if (commits) {
        core.info(
          `Commit metadata: ${commits.count} commit(s) by ${commits.authors.join(", ")}`
        );
      }
    }

    // --- Audit evidence: optional durable JSON report (includes integrity hash). --
    let integrityHash: string | undefined;
    if (reportPath) {
      integrityHash = writeComplianceReport(
        reportPath, release, repo, evaluation, tier, generatedAt, commits, profile
      );
      core.setOutput("integrity-hash", integrityHash);
    }

    await reportFreeTier(
      repo,
      release,
      evaluation,
      profile,
      tier,
      generatedAt,
      reportPath || undefined,
      integrityHash
    );

    core.setOutput("passed", String(evaluation.passed));
    core.setOutput("score", `${evaluation.score}/${evaluation.total}`);
    core.setOutput("profile", profile);

    // --- Premium gate: only when a license key is present. --------------------
    core.setOutput("tier", tier);

    if (licenseKey) {
      const premiumResult = await runPremiumAudit({
        licenseKey,
        release,
        repo,
        profile,
        logger: {
          info: (m: string) => core.info(m),
          warning: (m: string) => core.warning(m),
          debug: (m: string) => core.debug(m),
        },
      });

      const auditVerdict = premiumResult.auditResult?.governanceVerdict;
      if (auditVerdict) {
        core.setOutput("audit-verdict", auditVerdict.verdict);

        const verdictIcon =
          auditVerdict.verdict === "approved"
            ? "✅"
            : auditVerdict.verdict === "conditional"
            ? "⚠️"
            : "❌";

        try {
          let summaryBuilder = core.summary
            .addHeading("Premium Compliance Audit — Governance Verdict", 3)
            .addTable([
              [
                { data: "Status", header: true },
                { data: "Verdict", header: true },
                { data: "Reason", header: true },
              ],
              [verdictIcon, auditVerdict.verdict.toUpperCase(), auditVerdict.reason],
            ]);

          const controlMapping = premiumResult.auditResult?.controlMapping
            ?? premiumResult.auditResult?.isoControlMapping;
          if (controlMapping && Object.keys(controlMapping).length > 0) {
            summaryBuilder = summaryBuilder
              .addHeading("Compliance Control Mapping", 4)
              .addTable([
                [
                  { data: "Control", header: true },
                  { data: "Description", header: true },
                ],
                ...Object.entries(controlMapping).map(([ctrl, desc]) => [ctrl, desc]),
              ]);
          }

          await summaryBuilder.write();
        } catch (err) {
          core.debug(
            `Could not write premium verdict to summary: ${(err as Error).message}`
          );
        }
      }
    } else {
      core.info(
        "No license key provided — running free tier only. Add a 'license-key' input to enable premium AI compliance auditing."
      );
    }

    // --- Optional hard gate on the free-tier checklist. -----------------------
    if (evaluation.passed) {
      core.info(
        `✅ All ${evaluation.score}/${evaluation.total} compliance checks passed (profile: ${profile})`
      );
    } else if (failOnIncomplete) {
      core.setFailed(buildFailureMessage(profile, evaluation));
    }
  } catch (error) {
    core.setFailed(`Release compliance action failed: ${(error as Error).message}`);
  }
}

// Only auto-run when invoked as the action entry point (not when imported in tests).
if (import.meta.main) {
  run();
}

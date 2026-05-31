import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import * as core from "@actions/core";
import * as github from "@actions/github";

import { fetchReleaseCommits } from "./commits.js";
import { parseReleaseFromContext } from "./context.js";
import { evaluateChecklist, getRulesForProfile } from "./checklist.js";
import { runPremiumAudit } from "./premium.js";
import { buildComplianceReport, serializeReport } from "./report.js";
import type { ActionContext, CommitMetadata, Release, Repo, EvaluateResult, ComplianceProfile, Logger } from "./types.js";

export { parseReleaseFromContext };

/** Render the free-tier checklist results to the GitHub job summary + log. */
async function reportFreeTier(
  release: Release,
  evaluation: EvaluateResult,
  profile: ComplianceProfile
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
    await core.summary
      .addHeading("Release Compliance Report", 2)
      .addRaw(`**Release:** \`${release.tag}\` — ${release.name}\n\n`)
      .addRaw(
        `**Profile:** \`${profile}\` | **Result:** ${evaluation.score}/${evaluation.total} checks passed (tier: free)\n`
      )
      .addTable([
        [
          { data: "Status", header: true },
          { data: "Check", header: true },
        ],
        ...evaluation.results.map((item) => [item.ok ? "✅" : "❌", item.label]),
      ])
      .write();
  } catch (err) {
    // Summary is best-effort (e.g. unavailable in some runners); never fail on it.
    core.debug(`Could not write job summary: ${(err as Error).message}`);
  }
}

const VALID_PROFILES: ComplianceProfile[] = ["default", "iso27001", "soc2", "dora"];

/**
 * Write a durable, machine-readable compliance report to disk so it can be
 * archived as audit evidence (e.g. a CI artifact). Because the user explicitly
 * requested a report path, an I/O failure here is treated as a hard failure
 * rather than swallowed.
 */
function writeComplianceReport(
  reportPath: string,
  release: Release,
  repo: Repo,
  evaluation: EvaluateResult,
  tier: "free" | "premium",
  commits?: CommitMetadata
): void {
  const report = buildComplianceReport({
    release,
    repo,
    evaluation,
    tier,
    generatedAt: new Date().toISOString(),
    commits,
  });

  const dir = dirname(reportPath);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(reportPath, serializeReport(report), "utf8");

  core.info(`Wrote compliance report to ${reportPath}`);
  core.setOutput("report-path", reportPath);
}

export async function run(): Promise<void> {
  try {
    const token = core.getInput("github-token", { required: true });
    const licenseKey = core.getInput("license-key");
    const failOnIncomplete = core.getBooleanInput("fail-on-incomplete");
    const rawProfile = core.getInput("compliance-profile").trim().toLowerCase();
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
    const rules = getRulesForProfile(profile);
    const evaluation = evaluateChecklist(body, { release }, rules);
    await reportFreeTier(release, evaluation, profile);

    core.setOutput("passed", String(evaluation.passed));
    core.setOutput("score", `${evaluation.score}/${evaluation.total}`);
    core.setOutput("profile", profile);

    // --- Premium gate: only when a license key is present. --------------------
    const tier = licenseKey ? "premium" : "free";
    core.setOutput("tier", tier);

    // --- Commit metadata enrichment: best-effort, release events only. --------
    const repo = context.repo ?? { owner: "", repo: "" };
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

    // --- Audit evidence: optional durable JSON report. ------------------------
    if (reportPath) {
      writeComplianceReport(reportPath, release, repo, evaluation, tier, commits);
    }

    if (licenseKey) {
      await runPremiumAudit({
        licenseKey,
        release,
        repo,
        logger: {
          info: (m: string) => core.info(m),
          warning: (m: string) => core.warning(m),
          debug: (m: string) => core.debug(m),
        },
      });
    } else {
      core.info(
        "No license key provided — running free tier only. Add a 'license-key' input to enable premium AI compliance auditing."
      );
    }

    // --- Optional hard gate on the free-tier checklist. -----------------------
    if (!evaluation.passed && failOnIncomplete) {
      core.setFailed(
        `Release compliance checklist incomplete: ${evaluation.score}/${evaluation.total} passed.`
      );
    }
  } catch (error) {
    core.setFailed(`Release compliance action failed: ${(error as Error).message}`);
  }
}

// Only auto-run when invoked as the action entry point (not when imported in tests).
if (import.meta.main) {
  run();
}

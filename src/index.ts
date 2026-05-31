import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import * as core from "@actions/core";
import * as github from "@actions/github";

import { evaluateChecklist } from "./checklist.js";
import { runPremiumAudit } from "./premium.js";
import { buildComplianceReport, serializeReport } from "./report.js";
import type { Release, Repo, EvaluateResult, ActionContext } from "./types.js";

/**
 * Pull a normalized release object out of the event payload.
 *
 * Supports the `release` event (release.body) and falls back gracefully for
 * `push` tag events where no rich release body exists.
 */
export function parseReleaseFromContext(context: ActionContext): {
  release: Release | null;
  body: string;
} {
  const payload = context.payload ?? {};
  const release = payload.release as Record<string, unknown> | undefined;

  if (release) {
    return {
      release: {
        tag: release.tag_name as string,
        name: (release.name as string) || (release.tag_name as string),
        body: (release.body as string) || "",
        isPrerelease: Boolean(release.prerelease),
        isDraft: Boolean(release.draft),
        publishedAt: (release.published_at as string) || null,
        author: release.author
          ? ((release.author as { login: string }).login ?? null)
          : null,
        url: (release.html_url as string) || null,
      },
      body: (release.body as string) || "",
    };
  }

  // Tag push fallback: no release notes, but we can still report the ref.
  const ref = (payload.ref as string | undefined) ?? context.ref ?? "";
  const tag = ref.replace(/^refs\/tags\//, "");
  return {
    release: tag
      ? {
          tag,
          name: tag,
          body: "",
          isPrerelease: false,
          isDraft: false,
          publishedAt: null,
          author: context.actor ?? null,
          url: null,
        }
      : null,
    body: "",
  };
}

/** Render the free-tier checklist results to the GitHub job summary + log. */
async function reportFreeTier(
  release: Release,
  evaluation: EvaluateResult
): Promise<void> {
  core.info("─".repeat(60));
  core.info(`Release compliance check — ${release.name} (${release.tag})`);
  core.info(`Result: ${evaluation.score}/${evaluation.total} checks passed`);

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
        `**Result:** ${evaluation.score}/${evaluation.total} checks passed (tier: free)\n`
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
  tier: "free" | "premium"
): void {
  const report = buildComplianceReport({
    release,
    repo,
    evaluation,
    tier,
    generatedAt: new Date().toISOString(),
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
    const complianceProfile = core.getInput("compliance-profile") || "general";
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
      return;
    }

    core.debug(`Compliance profile: ${complianceProfile}`);

    // --- Free tier: always runs, fully local. ---------------------------------
    const evaluation = evaluateChecklist(body, { release });
    await reportFreeTier(release, evaluation);

    core.setOutput("passed", String(evaluation.passed));
    core.setOutput("score", `${evaluation.score}/${evaluation.total}`);

    // --- Premium gate: only when a license key is present. --------------------
    const tier = licenseKey ? "premium" : "free";
    core.setOutput("tier", tier);

    // --- Audit evidence: optional durable JSON report. ------------------------
    if (reportPath) {
      const repo = context.repo ?? { owner: "", repo: "" };
      writeComplianceReport(reportPath, release, repo, evaluation, tier);
    }

    if (licenseKey) {
      // `token` will be used by the future backend bridge to enrich the audit.
      void token;
      await runPremiumAudit({
        licenseKey,
        release,
        repo: context.repo ?? { owner: "", repo: "" },
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

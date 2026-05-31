import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import * as core from "@actions/core";
import * as github from "@actions/github";

import { evaluateChecklist, getRulesForProfile } from "./checklist.js";
import { runPremiumAudit } from "./premium.js";
import { buildComplianceReport, serializeReport } from "./report.js";
import type { Release, Repo, EvaluateResult, ActionContext, ComplianceProfile, CommitMetadata, Logger } from "./types.js";

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

/**
 * Fetch the commits that make up a release by comparing the current tag against
 * its predecessor via the GitHub API. Best-effort: returns `undefined` and logs a
 * warning if the previous tag cannot be determined or the API call fails.
 */
export async function fetchReleaseCommits(
  octokit: ReturnType<typeof github.getOctokit>,
  repo: Repo,
  currentTag: string,
  logger: Logger
): Promise<CommitMetadata | undefined> {
  try {
    const tagsResponse = await octokit.rest.repos.listTags({
      owner: repo.owner,
      repo: repo.repo,
      per_page: 10,
    });

    const tags = tagsResponse.data.map((t) => t.name);
    const currentIndex = tags.indexOf(currentTag);

    if (currentIndex === -1) {
      logger.warning(`Tag ${currentTag} not found in recent tags list; skipping commit enrichment.`);
      return undefined;
    }

    const previousTag = tags[currentIndex + 1];
    if (!previousTag) {
      logger.warning(`No previous tag found for ${currentTag}; skipping commit enrichment.`);
      return undefined;
    }

    const compareResponse = await octokit.rest.repos.compareCommitsWithBasehead({
      owner: repo.owner,
      repo: repo.repo,
      basehead: `${previousTag}...${currentTag}`,
    });

    const commits = compareResponse.data.commits;
    const authorsSet = new Set<string>();
    for (const commit of commits) {
      const author = commit.author?.login ?? commit.commit.author?.name ?? "unknown";
      authorsSet.add(author);
    }

    logger.info(`Commit enrichment: ${commits.length} commits by [${[...authorsSet].join(", ")}] between ${previousTag} and ${currentTag}.`);

    return {
      count: commits.length,
      authors: [...authorsSet],
      shas: commits.map((c) => c.sha),
    };
  } catch (err) {
    logger.warning(`Failed to fetch commit metadata: ${(err as Error).message}; skipping commit enrichment.`);
    return undefined;
  }
}

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

    // --- Audit evidence: optional durable JSON report. ------------------------
    if (reportPath) {
      const repo = context.repo ?? { owner: "", repo: "" };

      // Best-effort commit enrichment — only available on `release` events.
      let commits: CommitMetadata | undefined;
      if (context.payload?.release) {
        const octokit = github.getOctokit(token);
        const logger: Logger = {
          info: (m: string) => core.info(m),
          warning: (m: string) => core.warning(m),
          debug: (m: string) => core.debug(m),
        };
        commits = await fetchReleaseCommits(octokit, repo, release.tag, logger);
      } else {
        core.debug("Not a release event; skipping commit enrichment.");
      }

      writeComplianceReport(reportPath, release, repo, evaluation, tier, commits);
    }

    if (licenseKey) {
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

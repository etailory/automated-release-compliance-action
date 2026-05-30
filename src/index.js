import * as core from "@actions/core";
import * as github from "@actions/github";

import { evaluateChecklist } from "./checklist.js";
import { runPremiumAudit } from "./premium.js";

/**
 * Pull a normalized release object out of the event payload.
 *
 * Supports the `release` event (release.body) and falls back gracefully for
 * `push` tag events where no rich release body exists.
 * @param {object} context  github.context
 * @returns {{ release: object|null, body: string }}
 */
export function parseReleaseFromContext(context) {
  const payload = context.payload || {};
  const release = payload.release;

  if (release) {
    return {
      release: {
        tag: release.tag_name,
        name: release.name || release.tag_name,
        body: release.body || "",
        isPrerelease: Boolean(release.prerelease),
        isDraft: Boolean(release.draft),
        publishedAt: release.published_at || null,
        author: release.author ? release.author.login : null,
        url: release.html_url || null,
      },
      body: release.body || "",
    };
  }

  // Tag push fallback: no release notes, but we can still report the ref.
  const ref = payload.ref || context.ref || "";
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
          author: context.actor || null,
          url: null,
        }
      : null,
    body: "",
  };
}

/** Render the free-tier checklist results to the GitHub job summary + log. */
async function reportFreeTier(release, evaluation) {
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
    core.debug(`Could not write job summary: ${err.message}`);
  }
}

export async function run() {
  try {
    const token = core.getInput("github-token", { required: true });
    const licenseKey = core.getInput("license-key");
    const failOnIncomplete = core.getBooleanInput("fail-on-incomplete");

    const context = github.context;
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

    // --- Free tier: always runs, fully local. ---------------------------------
    const evaluation = evaluateChecklist(body, { release });
    await reportFreeTier(release, evaluation);

    core.setOutput("passed", String(evaluation.passed));
    core.setOutput("score", `${evaluation.score}/${evaluation.total}`);

    // --- Premium gate: only when a license key is present. --------------------
    const tier = licenseKey ? "premium" : "free";
    core.setOutput("tier", tier);

    if (licenseKey) {
      // `token` will be used by the future backend bridge to enrich the audit.
      void token;
      await runPremiumAudit({
        licenseKey,
        release,
        repo: context.repo,
        logger: {
          info: (m) => core.info(m),
          warning: (m) => core.warning(m),
          debug: (m) => core.debug(m),
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
    core.setFailed(`Release compliance action failed: ${error.message}`);
  }
}

// Only auto-run when invoked as the action entry point (not when imported in tests).
if (import.meta.main) {
  run();
}

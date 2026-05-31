import type { Release, Repo, EvaluateResult, ComplianceProfile } from "./types.js";

export interface SummaryParams {
  repo: Repo;
  release: Release;
  evaluation: EvaluateResult;
  profile: ComplianceProfile;
  tier: "free" | "premium";
  generatedAt: string;
  reportPath?: string;
}

/** Minimal subset of @actions/core Summary methods used by this module. */
export interface SummaryBuilder {
  addHeading(text: string, level?: number | string): this;
  addTable(rows: Array<Array<{ data: string; header?: boolean } | string>>): this;
  addRaw(text: string, addEOL?: boolean): this;
  write(): Promise<unknown>;
}

/**
 * Write a formatted compliance job summary using the provided builder.
 * Accepts a SummaryBuilder so it can be tested without the @actions/core runtime.
 */
export async function buildJobSummary(
  params: SummaryParams,
  builder: SummaryBuilder
): Promise<void> {
  const { repo, release, evaluation, profile, tier, generatedAt, reportPath } = params;
  const repoFullName = `${repo.owner}/${repo.repo}`;
  const overallIcon = evaluation.passed ? "✅" : "❌";

  builder
    .addHeading("Release Compliance Report", 2)
    .addTable([
      [
        { data: "Field", header: true },
        { data: "Value", header: true },
      ],
      ["Repository", repoFullName],
      ["Release Tag", `\`${release.tag}\``],
      ["Release Name", release.name],
      ["Compliance Profile", `\`${profile}\``],
      ["Generated At", generatedAt],
    ])
    .addHeading("Checklist Results", 3)
    .addTable([
      [
        { data: "Status", header: true },
        { data: "Check", header: true },
        { data: "Notes", header: true },
      ],
      ...evaluation.results.map((item) => [
        item.ok ? "✅" : "❌",
        item.label,
        item.evidence?.join(", ") ?? "",
      ]),
    ])
    .addRaw(
      `\n**Overall:** ${overallIcon} ${evaluation.score}/${evaluation.total} checks passed` +
        ` — Tier: \`${tier}\`\n`
    );

  if (reportPath) {
    builder.addRaw(`\n**Artifact:** \`${reportPath}\`\n`);
  }

  await builder.write();
}

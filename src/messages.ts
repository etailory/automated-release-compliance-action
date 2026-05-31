import type { ComplianceProfile, EvaluateResult } from "./types.js";

/**
 * Build a profile-aware failure message listing every check that did not pass,
 * including its controlRef when available.
 */
export function buildFailureMessage(
  profile: ComplianceProfile,
  evaluation: EvaluateResult
): string {
  const failing = evaluation.results.filter((r) => !r.ok);
  const lines = [
    `Release compliance checklist incomplete (${profile}, ${evaluation.score}/${evaluation.total} passed). Failing checks:`,
    ...failing.map((r) => {
      const ref = r.controlRef ? `[${r.controlRef}] ` : "";
      return `  - ${ref}${r.label}`;
    }),
  ];
  return lines.join("\n");
}

import type { CheckRule, CheckResult, EvaluateResult, ComplianceProfile } from "./types.js";

/** Matches links to an issue/PR/ticket: #123, GH URLs, or JIRA-style KEYS (ABC-123). */
const ISSUE_REFERENCE = /(#\d+)|(\/issues\/\d+)|(\/pull\/\d+)|\b[A-Z][A-Z0-9]+-\d+\b/;

/** A "meaningful description" heuristic: more than a handful of words. */
const MIN_DESCRIPTION_WORDS = 8;

/** Minimum character count for a release body to be considered substantive. */
const MIN_BODY_CHARS = 80;

/** Common changelog section header patterns. */
const CHANGELOG_HEADER = /^#{1,3}\s*(what'?s\s+changed|change\s*log|changes|breaking\s+changes|release\s+notes)/im;

/** Security review acknowledgement patterns. */
const SECURITY_NOTE = /security\s+(review|assessment|impact|note|scan|fix)|no\s+security\s+impact|cve[-\s]?\d|vulnerabilit/i;

/** Test/QA evidence patterns. */
const TESTING_EVIDENCE = /tested|test\s+coverage|qa\s+sign[- ]?off|regression\s+test|test\s+plan|ci\s+pass/i;

/** Risk or impact assessment patterns (DORA). */
const RISK_IMPACT = /risk\s+(assessment|level|impact)|impact\s+(analysis|assessment)|rollback\s+plan|blast\s+radius|criticality|rto\b|rpo\b/i;

export const DEFAULT_RULES: CheckRule[] = [
  {
    id: "has-description",
    label: "Release notes contain a description of the changes",
    test: (body) => countWords(body) >= MIN_DESCRIPTION_WORDS,
  },
  {
    id: "has-issue-reference",
    label: "Release notes link to an issue, pull request, or ticket",
    test: (body) => ISSUE_REFERENCE.test(body),
  },
  {
    id: "not-placeholder",
    label: "Release notes are not an empty or auto-generated placeholder",
    test: (body) => {
      const normalized = body.trim().toLowerCase();
      if (normalized.length === 0) return false;
      const placeholders = ["no changes", "tbd", "todo", "n/a", "wip"];
      return !placeholders.includes(normalized);
    },
  },
  {
    id: "has-changelog-section",
    label: "Release notes include a changelog or 'What's Changed' section heading",
    test: (body) => CHANGELOG_HEADER.test(body),
  },
  {
    id: "meets-min-length",
    label: `Release notes are at least ${MIN_BODY_CHARS} characters`,
    test: (body) => body.trim().length >= MIN_BODY_CHARS,
  },
];

/** ISO 27001 adds a mandatory security review acknowledgement. */
export const ISO27001_RULES: CheckRule[] = [
  ...DEFAULT_RULES,
  {
    id: "has-security-note",
    label: "Release notes acknowledge security review or confirm no security impact",
    test: (body) => SECURITY_NOTE.test(body),
  },
];

/** SOC2 adds evidence of testing and QA sign-off. */
export const SOC2_RULES: CheckRule[] = [
  ...DEFAULT_RULES,
  {
    id: "has-testing-evidence",
    label: "Release notes include evidence of testing or QA sign-off",
    test: (body) => TESTING_EVIDENCE.test(body),
  },
];

/** DORA adds a mandatory risk/impact assessment for operational resilience. */
export const DORA_RULES: CheckRule[] = [
  ...DEFAULT_RULES,
  {
    id: "has-risk-impact",
    label: "Release notes include a risk or impact assessment (DORA operational resilience)",
    test: (body) => RISK_IMPACT.test(body),
  },
];

/** Map a compliance profile name to its rule set. */
export function getRulesForProfile(profile: ComplianceProfile): CheckRule[] {
  switch (profile) {
    case "iso27001": return ISO27001_RULES;
    case "soc2":     return SOC2_RULES;
    case "dora":     return DORA_RULES;
    default:         return DEFAULT_RULES;
  }
}

function countWords(text: string): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Run the checklist against a release body.
 * @param body     The release notes / tag body text.
 * @param ctx      Optional context passed to each rule.
 * @param rules    Override the default rule set (useful for tests / profile selection).
 */
export function evaluateChecklist(
  body = "",
  ctx: Record<string, unknown> = {},
  rules: CheckRule[] = DEFAULT_RULES
): EvaluateResult {
  const safeBody = typeof body === "string" ? body : "";
  const results: CheckResult[] = rules.map((rule) => ({
    id: rule.id,
    label: rule.label,
    ok: Boolean(rule.test(safeBody, ctx)),
  }));

  const score = results.filter((r) => r.ok).length;
  return {
    passed: score === results.length,
    score,
    total: results.length,
    results,
  };
}

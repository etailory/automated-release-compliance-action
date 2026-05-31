import type { CheckRule, CheckResult, EvaluateResult, ComplianceProfile } from "./types.js";

/** Matches links to an issue/PR/ticket: #123, GH URLs, or JIRA-style KEYS (ABC-123). */
const ISSUE_REFERENCE = /(#\d+)|(\/issues\/\d+)|(\/pull\/\d+)|\b[A-Z][A-Z0-9]+-\d+\b/;
/** Global variant used to extract all matches from a body string. */
const ISSUE_REFERENCE_G = new RegExp(ISSUE_REFERENCE.source, "g");

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
    controlRef: "CTRL-1",
    test: (body) => countWords(body) >= MIN_DESCRIPTION_WORDS,
  },
  {
    id: "has-issue-reference",
    label: "Release notes link to an issue, pull request, or ticket",
    controlRef: "CTRL-2",
    test: (body) => ISSUE_REFERENCE.test(body),
    extract: (body) => {
      ISSUE_REFERENCE_G.lastIndex = 0;
      const found: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = ISSUE_REFERENCE_G.exec(body)) !== null) {
        const ref = m[0].trim();
        if (ref) found.push(ref);
      }
      return [...new Set(found)];
    },
  },
  {
    id: "not-placeholder",
    label: "Release notes are not an empty or auto-generated placeholder",
    controlRef: "CTRL-3",
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
    controlRef: "CTRL-4",
    test: (body) => CHANGELOG_HEADER.test(body),
    extract: (body) => {
      const m = CHANGELOG_HEADER.exec(body);
      return m ? [m[0].trim()] : [];
    },
  },
  {
    id: "meets-min-length",
    label: `Release notes are at least ${MIN_BODY_CHARS} characters`,
    controlRef: "CTRL-5",
    test: (body) => body.trim().length >= MIN_BODY_CHARS,
  },
];

/** ISO 27001 adds a mandatory security review acknowledgement. */
export const ISO27001_RULES: CheckRule[] = [
  ...DEFAULT_RULES,
  {
    id: "has-security-note",
    label: "Release notes acknowledge security review or confirm no security impact",
    controlRef: "A.12.1.2",
    test: (body) => SECURITY_NOTE.test(body),
  },
];

/** SOC2 adds evidence of testing and QA sign-off. */
export const SOC2_RULES: CheckRule[] = [
  ...DEFAULT_RULES,
  {
    id: "has-testing-evidence",
    label: "Release notes include evidence of testing or QA sign-off",
    controlRef: "CC8.1",
    test: (body) => TESTING_EVIDENCE.test(body),
  },
];

/** DORA adds a mandatory risk/impact assessment for operational resilience. */
export const DORA_RULES: CheckRule[] = [
  ...DEFAULT_RULES,
  {
    id: "has-risk-impact",
    label: "Release notes include a risk or impact assessment (DORA operational resilience)",
    controlRef: "Art.9",
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
  const results: CheckResult[] = rules.map((rule) => {
    const ok = Boolean(rule.test(safeBody, ctx));
    const result: CheckResult = { id: rule.id, label: rule.label, ok };
    if (rule.controlRef) result.controlRef = rule.controlRef;
    if (rule.extract) {
      const evidence = rule.extract(safeBody);
      if (evidence.length > 0) result.evidence = evidence;
    }
    return result;
  });

  const score = results.filter((r) => r.ok).length;
  return {
    passed: score === results.length,
    score,
    total: results.length,
    results,
  };
}

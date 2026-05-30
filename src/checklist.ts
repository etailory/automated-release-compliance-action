import type { CheckRule, CheckResult, EvaluateResult } from "./types.js";

/** Matches links to an issue/PR/ticket: #123, GH URLs, or JIRA-style KEYS (ABC-123). */
const ISSUE_REFERENCE = /(#\d+)|(\/issues\/\d+)|(\/pull\/\d+)|\b[A-Z][A-Z0-9]+-\d+\b/;

/** A "meaningful description" heuristic: more than a handful of words. */
const MIN_DESCRIPTION_WORDS = 8;

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
];

function countWords(text: string): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Run the checklist against a release body.
 * @param body   The release notes / tag body text.
 * @param ctx    Optional context passed to each rule.
 * @param rules  Override the default rule set (useful for tests).
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

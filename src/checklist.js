"use strict";

/**
 * Free-tier compliance checklist.
 *
 * Each check is intentionally lightweight and runs entirely inside the action
 * (no network calls). The goal is to nudge developers toward documenting risk
 * at release time. Heavy, AI-driven auditing lives behind the premium bridge.
 */

/**
 * A single checklist rule.
 * @typedef {Object} CheckRule
 * @property {string} id            Stable identifier for the rule.
 * @property {string} label         Human-readable description shown in the summary.
 * @property {(body: string, ctx: object) => boolean} test  Predicate over the release body.
 */

/** Matches links to an issue/PR/ticket: #123, GH URLs, or JIRA-style KEYS (ABC-123). */
const ISSUE_REFERENCE = /(#\d+)|(\/issues\/\d+)|(\/pull\/\d+)|\b[A-Z][A-Z0-9]+-\d+\b/;

/** A "meaningful description" heuristic: more than a handful of words. */
const MIN_DESCRIPTION_WORDS = 8;

/** @type {CheckRule[]} */
const DEFAULT_RULES = [
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

function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Run the checklist against a release body.
 * @param {string} body              The release notes / tag body text.
 * @param {object} [ctx]             Optional context passed to each rule.
 * @param {CheckRule[]} [rules]      Override the default rule set (useful for tests).
 * @returns {{ passed: boolean, score: number, total: number, results: Array<{id:string,label:string,ok:boolean}> }}
 */
function evaluateChecklist(body = "", ctx = {}, rules = DEFAULT_RULES) {
  const safeBody = typeof body === "string" ? body : "";
  const results = rules.map((rule) => ({
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

module.exports = { evaluateChecklist, DEFAULT_RULES };

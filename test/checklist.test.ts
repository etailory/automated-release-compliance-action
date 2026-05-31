import { test, expect } from "bun:test";

import { evaluateChecklist, getRulesForProfile, DEFAULT_RULES, ISO27001_RULES, SOC2_RULES, DORA_RULES } from "../src/checklist.js";
import { buildAuditPayload } from "../src/premium.js";
import { buildComplianceReport } from "../src/report.js";
import { parseReleaseFromContext } from "../src/index.js";
import type { Release, Repo } from "../src/types.js";

test("checklist passes for a well-documented release", () => {
  const body =
    "## What's Changed\n\nThis release fixes the login regression and updates the billing flow. See #42 for details.";
  const result = evaluateChecklist(body);
  expect(result.passed).toBe(true);
  expect(result.score).toBe(result.total);
});

test("checklist fails for an empty release body", () => {
  const result = evaluateChecklist("");
  expect(result.passed).toBe(false);
  expect(result.score).toBe(0);
});

test("checklist detects a missing issue reference", () => {
  const body = "We shipped a bunch of internal refactors across the codebase today.";
  const result = evaluateChecklist(body);
  const issueCheck = result.results.find((r) => r.id === "has-issue-reference");
  expect(issueCheck?.ok).toBe(false);
});

test("checklist detects JIRA-style ticket references", () => {
  const body =
    "Resolved the data export defect and refreshed the dashboard widgets. Ref ABC-1234.";
  const result = evaluateChecklist(body);
  const issueCheck = result.results.find((r) => r.id === "has-issue-reference");
  expect(issueCheck?.ok).toBe(true);
});

test("placeholder bodies are rejected", () => {
  const result = evaluateChecklist("TBD");
  const placeholderCheck = result.results.find((r) => r.id === "not-placeholder");
  expect(placeholderCheck?.ok).toBe(false);
});

test("parseReleaseFromContext reads a release event payload", () => {
  const { release, body } = parseReleaseFromContext({
    payload: {
      release: {
        tag_name: "v1.2.0",
        name: "Spring Release",
        body: "Notes here #1",
        prerelease: false,
        draft: false,
        published_at: "2026-05-30T00:00:00Z",
        author: { login: "octocat" },
        html_url: "https://example.com/r",
      },
    },
  });
  expect(release?.tag).toBe("v1.2.0");
  expect(release?.author).toBe("octocat");
  expect(body).toBe("Notes here #1");
});

test("parseReleaseFromContext falls back to a tag push ref", () => {
  const { release } = parseReleaseFromContext({
    payload: { ref: "refs/tags/v9.9.9" },
    actor: "octocat",
  });
  expect(release?.tag).toBe("v9.9.9");
});

// --- new rules ---

const FULL_RELEASE_BODY = `## What's Changed

This release ships the new billing module and fixes the login regression.
See #42 and #43 for details.

Security review: no security impact assessed.
All changes were tested against the regression suite (QA sign-off: passed).
Risk assessment: low risk — rollback via revert commit if needed.
`.trim();

test("has-changelog-section passes for a '## What's Changed' header", () => {
  const result = evaluateChecklist(FULL_RELEASE_BODY);
  const check = result.results.find((r) => r.id === "has-changelog-section");
  expect(check?.ok).toBe(true);
});

test("has-changelog-section fails when no section header is present", () => {
  const body = "This release fixes the login bug. See #10 for full context and details.";
  const result = evaluateChecklist(body);
  const check = result.results.find((r) => r.id === "has-changelog-section");
  expect(check?.ok).toBe(false);
});

test("meets-min-length passes for a body >= 80 characters", () => {
  const result = evaluateChecklist(FULL_RELEASE_BODY);
  const check = result.results.find((r) => r.id === "meets-min-length");
  expect(check?.ok).toBe(true);
});

test("meets-min-length fails for a short body", () => {
  const result = evaluateChecklist("Short body. #1");
  const check = result.results.find((r) => r.id === "meets-min-length");
  expect(check?.ok).toBe(false);
});

// --- profile selection ---

test("getRulesForProfile returns DEFAULT_RULES for 'default'", () => {
  expect(getRulesForProfile("default")).toBe(DEFAULT_RULES);
});

test("getRulesForProfile returns ISO27001_RULES for 'iso27001'", () => {
  expect(getRulesForProfile("iso27001")).toBe(ISO27001_RULES);
});

test("getRulesForProfile returns SOC2_RULES for 'soc2'", () => {
  expect(getRulesForProfile("soc2")).toBe(SOC2_RULES);
});

test("getRulesForProfile returns DORA_RULES for 'dora'", () => {
  expect(getRulesForProfile("dora")).toBe(DORA_RULES);
});

test("iso27001 profile: has-security-note passes when security review is mentioned", () => {
  const rules = getRulesForProfile("iso27001");
  const result = evaluateChecklist(FULL_RELEASE_BODY, {}, rules);
  const check = result.results.find((r) => r.id === "has-security-note");
  expect(check?.ok).toBe(true);
});

test("iso27001 profile: has-security-note fails when no security note is present", () => {
  const body = "## What's Changed\n\nFixed the billing bug. See #5 for details. This is a sufficiently long description.";
  const rules = getRulesForProfile("iso27001");
  const result = evaluateChecklist(body, {}, rules);
  const check = result.results.find((r) => r.id === "has-security-note");
  expect(check?.ok).toBe(false);
});

test("soc2 profile: has-testing-evidence passes when QA sign-off is mentioned", () => {
  const rules = getRulesForProfile("soc2");
  const result = evaluateChecklist(FULL_RELEASE_BODY, {}, rules);
  const check = result.results.find((r) => r.id === "has-testing-evidence");
  expect(check?.ok).toBe(true);
});

test("soc2 profile: has-testing-evidence fails without testing mention", () => {
  const body = "## What's Changed\n\nFixed the billing bug. See #5 for details. This is a sufficiently long release note.";
  const rules = getRulesForProfile("soc2");
  const result = evaluateChecklist(body, {}, rules);
  const check = result.results.find((r) => r.id === "has-testing-evidence");
  expect(check?.ok).toBe(false);
});

test("dora profile: has-risk-impact passes when rollback plan is mentioned", () => {
  const rules = getRulesForProfile("dora");
  const result = evaluateChecklist(FULL_RELEASE_BODY, {}, rules);
  const check = result.results.find((r) => r.id === "has-risk-impact");
  expect(check?.ok).toBe(true);
});

test("dora profile: has-risk-impact fails without risk assessment", () => {
  const body = "## What's Changed\n\nFixed the billing bug. See #5 for details. This is a sufficiently long release note.";
  const rules = getRulesForProfile("dora");
  const result = evaluateChecklist(body, {}, rules);
  const check = result.results.find((r) => r.id === "has-risk-impact");
  expect(check?.ok).toBe(false);
});

// --- evidence extraction ---

test("has-issue-reference evidence lists all GitHub issue refs", () => {
  const body = "Fixed the billing bug. See #42 and #43 for details.";
  const result = evaluateChecklist(body);
  const check = result.results.find((r) => r.id === "has-issue-reference");
  expect(check?.ok).toBe(true);
  expect(check?.evidence).toContain("#42");
  expect(check?.evidence).toContain("#43");
  expect(check?.evidence?.length).toBe(2);
});

test("has-issue-reference evidence lists JIRA-style ticket refs", () => {
  const body = "Resolved PROJ-1234 and ABC-99 issues in this release.";
  const result = evaluateChecklist(body);
  const check = result.results.find((r) => r.id === "has-issue-reference");
  expect(check?.ok).toBe(true);
  expect(check?.evidence).toContain("PROJ-1234");
  expect(check?.evidence).toContain("ABC-99");
});

test("has-issue-reference evidence is absent when check fails", () => {
  const body = "Shipped some internal improvements to the codebase.";
  const result = evaluateChecklist(body);
  const check = result.results.find((r) => r.id === "has-issue-reference");
  expect(check?.ok).toBe(false);
  expect(check?.evidence).toBeUndefined();
});

test("has-issue-reference evidence deduplicates repeated refs", () => {
  const body = "Fixes #42, closes #42, see #42.";
  const result = evaluateChecklist(body);
  const check = result.results.find((r) => r.id === "has-issue-reference");
  expect(check?.evidence).toEqual(["#42"]);
});

test("has-changelog-section evidence captures the matched heading", () => {
  const body = "## What's Changed\n\nFixed the billing bug. See #5 for details.";
  const result = evaluateChecklist(body);
  const check = result.results.find((r) => r.id === "has-changelog-section");
  expect(check?.ok).toBe(true);
  expect(check?.evidence?.[0]).toMatch(/what'?s\s+changed/i);
});

test("evidence is deep-copied in compliance report snapshot", () => {
  const body = "Fixed the billing bug. See #42 for details. Ref ABC-99.";
  const evaluation = evaluateChecklist(body);
  const report = buildComplianceReport({
    release: { tag: "v1.0.0", name: "GA", body, isPrerelease: false, isDraft: false, publishedAt: null, author: "a", url: null },
    repo: { owner: "acme", repo: "widgets" },
    evaluation,
    tier: "free",
    generatedAt: "2026-05-31T00:00:00Z",
  });
  const issueCheck = evaluation.results.find((r) => r.id === "has-issue-reference")!;
  const reportCheck = report.compliance.checks.find((c) => c.id === "has-issue-reference")!;
  // Mutating the original evidence must not affect the snapshot.
  issueCheck.evidence!.push("FAKE-999");
  expect(reportCheck.evidence).not.toContain("FAKE-999");
});

test("buildAuditPayload shapes the premium request", () => {
  const release: Release = {
    tag: "v1.0.0",
    name: "GA",
    body: "",
    isPrerelease: false,
    isDraft: false,
    publishedAt: null,
    author: "a",
    url: null,
  };
  const repo: Repo = { owner: "acme", repo: "widgets" };
  const payload = buildAuditPayload(release, repo);
  expect(payload.repository).toBe("acme/widgets");
  expect(payload.release.tag).toBe("v1.0.0");
  expect(payload.requested.isoControlMapping).toBe(true);
});

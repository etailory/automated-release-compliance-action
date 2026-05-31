import { test, expect } from "bun:test";

import { evaluateChecklist } from "../src/checklist.js";
import {
  buildComplianceReport,
  serializeReport,
  REPORT_SCHEMA_VERSION,
  TOOL_NAME,
} from "../src/report.js";
import type { Release, Repo } from "../src/types.js";

const RELEASE: Release = {
  tag: "v1.2.0",
  name: "Spring Release",
  body: "## What's Changed\n\nFixes the login regression and updates the billing integration. All changes tested. See #42.",
  isPrerelease: false,
  isDraft: false,
  publishedAt: "2026-05-30T00:00:00Z",
  author: "octocat",
  url: "https://example.com/r",
};

const REPO: Repo = { owner: "acme", repo: "widgets" };
const AT = "2026-05-31T12:00:00.000Z";

test("buildComplianceReport captures release, repo, and evaluation", () => {
  const evaluation = evaluateChecklist(RELEASE.body);
  const report = buildComplianceReport({
    release: RELEASE,
    repo: REPO,
    evaluation,
    tier: "free",
    generatedAt: AT,
  });

  expect(report.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
  expect(report.tool.name).toBe(TOOL_NAME);
  expect(report.generatedAt).toBe(AT);
  expect(report.tier).toBe("free");
  expect(report.repository).toBe("acme/widgets");
  expect(report.release.tag).toBe("v1.2.0");
  expect(report.release.url).toBe("https://example.com/r");
  expect(report.compliance.passed).toBe(true);
  expect(report.compliance.score).toBe(report.compliance.total);
  expect(report.compliance.checks.length).toBe(evaluation.results.length);
});

test("buildComplianceReport records a failing evaluation faithfully", () => {
  const evaluation = evaluateChecklist("");
  const report = buildComplianceReport({
    release: RELEASE,
    repo: REPO,
    evaluation,
    tier: "premium",
    generatedAt: AT,
  });

  expect(report.tier).toBe("premium");
  expect(report.compliance.passed).toBe(false);
  expect(report.compliance.score).toBe(0);
  expect(report.compliance.checks.every((c) => c.ok === false)).toBe(true);
});

test("report snapshot is decoupled from the source evaluation", () => {
  const evaluation = evaluateChecklist(RELEASE.body);
  const report = buildComplianceReport({
    release: RELEASE,
    repo: REPO,
    evaluation,
    tier: "free",
    generatedAt: AT,
  });

  // Mutating the original results must not affect the captured report.
  evaluation.results[0]!.ok = false;
  expect(report.compliance.checks[0]!.ok).toBe(true);
});

test("serializeReport produces parseable JSON with a trailing newline", () => {
  const evaluation = evaluateChecklist(RELEASE.body);
  const report = buildComplianceReport({
    release: RELEASE,
    repo: REPO,
    evaluation,
    tier: "free",
    generatedAt: AT,
  });

  const json = serializeReport(report);
  expect(json.endsWith("\n")).toBe(true);
  expect(JSON.parse(json)).toEqual(report);
});

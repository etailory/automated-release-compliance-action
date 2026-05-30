"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const { evaluateChecklist } = require("../src/checklist");
const { buildAuditPayload } = require("../src/premium");
const { parseReleaseFromContext } = require("../src/index");

test("checklist passes for a well-documented release", () => {
  const body =
    "This release fixes the login regression and updates the billing flow. See #42 for details.";
  const result = evaluateChecklist(body);
  assert.strictEqual(result.passed, true);
  assert.strictEqual(result.score, result.total);
});

test("checklist fails for an empty release body", () => {
  const result = evaluateChecklist("");
  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.score, 0);
});

test("checklist detects a missing issue reference", () => {
  const body = "We shipped a bunch of internal refactors across the codebase today.";
  const result = evaluateChecklist(body);
  const issueCheck = result.results.find((r) => r.id === "has-issue-reference");
  assert.strictEqual(issueCheck.ok, false);
});

test("checklist detects JIRA-style ticket references", () => {
  const body =
    "Resolved the data export defect and refreshed the dashboard widgets. Ref ABC-1234.";
  const result = evaluateChecklist(body);
  const issueCheck = result.results.find((r) => r.id === "has-issue-reference");
  assert.strictEqual(issueCheck.ok, true);
});

test("placeholder bodies are rejected", () => {
  const result = evaluateChecklist("TBD");
  const placeholderCheck = result.results.find((r) => r.id === "not-placeholder");
  assert.strictEqual(placeholderCheck.ok, false);
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
  assert.strictEqual(release.tag, "v1.2.0");
  assert.strictEqual(release.author, "octocat");
  assert.strictEqual(body, "Notes here #1");
});

test("parseReleaseFromContext falls back to a tag push ref", () => {
  const { release } = parseReleaseFromContext({
    payload: { ref: "refs/tags/v9.9.9" },
    actor: "octocat",
  });
  assert.strictEqual(release.tag, "v9.9.9");
});

test("buildAuditPayload shapes the premium request", () => {
  const payload = buildAuditPayload(
    { tag: "v1.0.0", name: "GA", isPrerelease: false, isDraft: false, publishedAt: null, author: "a" },
    { owner: "acme", repo: "widgets" }
  );
  assert.strictEqual(payload.repository, "acme/widgets");
  assert.strictEqual(payload.release.tag, "v1.0.0");
  assert.strictEqual(payload.requested.isoControlMapping, true);
});

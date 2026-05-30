import { test, expect } from "bun:test";

import { evaluateChecklist } from "../src/checklist.js";
import { buildAuditPayload } from "../src/premium.js";
import { parseReleaseFromContext } from "../src/index.js";

test("checklist passes for a well-documented release", () => {
  const body =
    "This release fixes the login regression and updates the billing flow. See #42 for details.";
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
  expect(issueCheck.ok).toBe(false);
});

test("checklist detects JIRA-style ticket references", () => {
  const body =
    "Resolved the data export defect and refreshed the dashboard widgets. Ref ABC-1234.";
  const result = evaluateChecklist(body);
  const issueCheck = result.results.find((r) => r.id === "has-issue-reference");
  expect(issueCheck.ok).toBe(true);
});

test("placeholder bodies are rejected", () => {
  const result = evaluateChecklist("TBD");
  const placeholderCheck = result.results.find((r) => r.id === "not-placeholder");
  expect(placeholderCheck.ok).toBe(false);
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
  expect(release.tag).toBe("v1.2.0");
  expect(release.author).toBe("octocat");
  expect(body).toBe("Notes here #1");
});

test("parseReleaseFromContext falls back to a tag push ref", () => {
  const { release } = parseReleaseFromContext({
    payload: { ref: "refs/tags/v9.9.9" },
    actor: "octocat",
  });
  expect(release.tag).toBe("v9.9.9");
});

test("buildAuditPayload shapes the premium request", () => {
  const payload = buildAuditPayload(
    {
      tag: "v1.0.0",
      name: "GA",
      isPrerelease: false,
      isDraft: false,
      publishedAt: null,
      author: "a",
    },
    { owner: "acme", repo: "widgets" }
  );
  expect(payload.repository).toBe("acme/widgets");
  expect(payload.release.tag).toBe("v1.0.0");
  expect(payload.requested.isoControlMapping).toBe(true);
});

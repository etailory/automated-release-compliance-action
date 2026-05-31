import { test, expect } from "bun:test";

import { fetchReleaseCommits } from "../src/commits.js";
import { buildFailureMessage } from "../src/messages.js";
import type { EvaluateResult, Logger, Repo } from "../src/types.js";

const REPO: Repo = { owner: "acme", repo: "widgets" };

const SILENT_LOGGER: Logger = {
  info: () => {},
  warning: () => {},
  debug: () => {},
};

const TAGS = [
  { name: "v1.2.0" },
  { name: "v1.1.0" },
  { name: "v1.0.0" },
];

const COMMITS = [
  { sha: "aaaa", author: { login: "alice" }, commit: { author: { name: "Alice" } } },
  { sha: "bbbb", author: { login: "bob" }, commit: { author: { name: "Bob" } } },
  { sha: "cccc", author: null, commit: { author: { name: "Carol" } } },
];

function makeOctokit(overrides: {
  tags?: typeof TAGS;
  commits?: typeof COMMITS;
  compareError?: Error;
  listTagsError?: Error;
}) {
  return {
    rest: {
      repos: {
        listTags: async () => {
          if (overrides.listTagsError) throw overrides.listTagsError;
          return { data: overrides.tags ?? TAGS };
        },
        compareCommitsWithBasehead: async () => {
          if (overrides.compareError) throw overrides.compareError;
          return { data: { commits: overrides.commits ?? COMMITS } };
        },
        listCommits: async () => {
          return { data: overrides.commits ?? COMMITS };
        },
      },
    },
  };
}

test("fetchReleaseCommits returns commit metadata via tag comparison", async () => {
  const octokit = makeOctokit({});
  const result = await fetchReleaseCommits(octokit, REPO, "v1.2.0", SILENT_LOGGER);

  expect(result).not.toBeUndefined();
  expect(result!.count).toBe(3);
  expect(result!.shas).toEqual(["aaaa", "bbbb", "cccc"]);
  // alice and bob have logins; carol falls back to name
  expect(result!.authors).toContain("alice");
  expect(result!.authors).toContain("bob");
  expect(result!.authors).toContain("Carol");
  // unique authors only
  expect(new Set(result!.authors).size).toBe(result!.authors.length);
});

test("fetchReleaseCommits falls back to listCommits when no previous tag", async () => {
  // Only the current tag in the list — no previous tag.
  const octokit = makeOctokit({ tags: [{ name: "v1.2.0" }] });
  const warnings: string[] = [];
  const logger: Logger = { ...SILENT_LOGGER, warning: (m) => warnings.push(m) };

  const result = await fetchReleaseCommits(octokit, REPO, "v1.2.0", logger);

  expect(result).not.toBeUndefined();
  expect(result!.count).toBe(3);
  expect(warnings.length).toBeGreaterThan(0);
});

test("fetchReleaseCommits returns undefined and logs warning on API error", async () => {
  const octokit = makeOctokit({ listTagsError: new Error("API rate limit") });
  const warnings: string[] = [];
  const logger: Logger = { ...SILENT_LOGGER, warning: (m) => warnings.push(m) };

  const result = await fetchReleaseCommits(octokit, REPO, "v1.2.0", logger);

  expect(result).toBeUndefined();
  expect(warnings.some((w) => w.includes("API rate limit"))).toBe(true);
});

test("fetchReleaseCommits deduplicates authors", async () => {
  const duplicateCommits = [
    { sha: "aaaa", author: { login: "alice" }, commit: { author: { name: "Alice" } } },
    { sha: "bbbb", author: { login: "alice" }, commit: { author: { name: "Alice" } } },
    { sha: "cccc", author: { login: "bob" }, commit: { author: { name: "Bob" } } },
  ];
  const octokit = makeOctokit({ commits: duplicateCommits });
  const result = await fetchReleaseCommits(octokit, REPO, "v1.2.0", SILENT_LOGGER);

  expect(result!.authors).toEqual(["alice", "bob"]);
  expect(result!.count).toBe(3);
});

// --- buildFailureMessage ---

test("buildFailureMessage includes profile, score, and failing rule labels", () => {
  const evaluation: EvaluateResult = {
    passed: false,
    score: 4,
    total: 6,
    results: [
      { id: "a", label: "Check A", ok: true, controlRef: "CTRL-1" },
      { id: "b", label: "Release notes acknowledge security review or confirm no security impact", ok: false, controlRef: "A.12.1.2" },
      { id: "c", label: "Release notes include a changelog or 'What's Changed' section heading", ok: false, controlRef: "CTRL-4" },
    ],
  };
  const msg = buildFailureMessage("iso27001", evaluation);

  expect(msg).toContain("iso27001");
  expect(msg).toContain("4/6");
  expect(msg).toContain("[A.12.1.2]");
  expect(msg).toContain("Release notes acknowledge security review");
  expect(msg).toContain("[CTRL-4]");
  expect(msg).toContain("Release notes include a changelog");
  // Passing check must not appear in the failure list
  expect(msg).not.toContain("Check A");
});

test("buildFailureMessage omits controlRef bracket when not present", () => {
  const evaluation: EvaluateResult = {
    passed: false,
    score: 0,
    total: 1,
    results: [{ id: "x", label: "Some rule", ok: false }],
  };
  const msg = buildFailureMessage("default", evaluation);

  expect(msg).toContain("Some rule");
  expect(msg).not.toMatch(/\[.*\] Some rule/);
});

test("buildFailureMessage with all checks failing lists all rules", () => {
  const evaluation: EvaluateResult = {
    passed: false,
    score: 0,
    total: 2,
    results: [
      { id: "a", label: "Rule Alpha", ok: false, controlRef: "CC8.1" },
      { id: "b", label: "Rule Beta", ok: false, controlRef: "Art.9" },
    ],
  };
  const msg = buildFailureMessage("soc2", evaluation);

  expect(msg).toContain("[CC8.1]");
  expect(msg).toContain("Rule Alpha");
  expect(msg).toContain("[Art.9]");
  expect(msg).toContain("Rule Beta");
  expect(msg).toContain("0/2");
});

import { test, expect } from "bun:test";

import { fetchReleaseCommits } from "../src/commits.js";
import type { Logger, Repo } from "../src/types.js";

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

import { test, expect } from "bun:test";

import { fetchReleaseCommits } from "../src/index.js";
import type { Repo, Logger } from "../src/types.js";

const REPO: Repo = { owner: "acme", repo: "widgets" };

const SILENT_LOGGER: Logger = {
  info: () => {},
  warning: () => {},
  debug: () => {},
};

const SAMPLE_COMMITS = [
  { sha: "aaa111", author: { login: "alice" }, commit: { author: { name: "Alice" } } },
  { sha: "bbb222", author: null, commit: { author: { name: "bob" } } },
  { sha: "ccc333", author: { login: "alice" }, commit: { author: { name: "Alice" } } },
];

function makeOctokit(opts?: {
  tags?: Array<{ name: string }>;
  commits?: unknown[];
  compareError?: Error;
  tagsError?: Error;
}) {
  return {
    rest: {
      repos: {
        listTags: async (_p: unknown) => {
          if (opts?.tagsError) throw opts.tagsError;
          return { data: opts?.tags ?? [{ name: "v2.0.0" }, { name: "v1.0.0" }] };
        },
        compareCommitsWithBasehead: async (_p: unknown) => {
          if (opts?.compareError) throw opts.compareError;
          return { data: { commits: opts?.commits ?? SAMPLE_COMMITS } };
        },
      },
    },
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

test("fetchReleaseCommits returns commit metadata for a normal release", async () => {
  const octokit = makeOctokit();
  const result = await fetchReleaseCommits(octokit, REPO, "v2.0.0", SILENT_LOGGER);

  expect(result).not.toBeUndefined();
  expect(result!.count).toBe(3);
  // alice appears twice but should be deduplicated; bob has no login, falls back to name
  expect(result!.authors).toContain("alice");
  expect(result!.authors).toContain("bob");
  expect(result!.authors.length).toBe(2);
  expect(result!.shas).toEqual(["aaa111", "bbb222", "ccc333"]);
});

test("fetchReleaseCommits returns undefined when tag is not in list", async () => {
  const octokit = makeOctokit({ tags: [{ name: "v1.0.0" }] });
  const result = await fetchReleaseCommits(octokit, REPO, "v2.0.0", SILENT_LOGGER);
  expect(result).toBeUndefined();
});

test("fetchReleaseCommits returns undefined when there is no previous tag", async () => {
  // Only one tag — no previous tag exists
  const octokit = makeOctokit({ tags: [{ name: "v1.0.0" }] });
  const result = await fetchReleaseCommits(octokit, REPO, "v1.0.0", SILENT_LOGGER);
  expect(result).toBeUndefined();
});

test("fetchReleaseCommits returns undefined and logs a warning on API failure", async () => {
  const warnings: string[] = [];
  const logger: Logger = { ...SILENT_LOGGER, warning: (m) => warnings.push(m) };
  const octokit = makeOctokit({ compareError: new Error("API rate limit exceeded") });
  const result = await fetchReleaseCommits(octokit, REPO, "v2.0.0", logger);

  expect(result).toBeUndefined();
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain("API rate limit exceeded");
});

test("fetchReleaseCommits returns undefined and logs a warning on listTags failure", async () => {
  const warnings: string[] = [];
  const logger: Logger = { ...SILENT_LOGGER, warning: (m) => warnings.push(m) };
  const octokit = makeOctokit({ tagsError: new Error("network error") });
  const result = await fetchReleaseCommits(octokit, REPO, "v2.0.0", logger);

  expect(result).toBeUndefined();
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain("network error");
});

test("fetchReleaseCommits handles an empty commit list", async () => {
  const octokit = makeOctokit({ commits: [] });
  const result = await fetchReleaseCommits(octokit, REPO, "v2.0.0", SILENT_LOGGER);

  expect(result).not.toBeUndefined();
  expect(result!.count).toBe(0);
  expect(result!.authors).toEqual([]);
  expect(result!.shas).toEqual([]);
});

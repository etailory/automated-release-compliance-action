/**
 * Release commit enrichment — fetches the commits associated with a GitHub release
 * by comparing the release tag against the previous tag. This module is free of
 * @actions/core / @actions/github imports so it can be unit-tested without the
 * GitHub Actions runtime.
 */

import type { CommitMetadata, Logger, Repo } from "./types.js";

/** Minimal Octokit shape required by fetchReleaseCommits (satisfied by getOctokit()). */
export interface OctokitLike {
  rest: {
    repos: {
      listTags(params: {
        owner: string;
        repo: string;
        per_page: number;
      }): Promise<{ data: Array<{ name: string }> }>;
      compareCommitsWithBasehead(params: {
        owner: string;
        repo: string;
        basehead: string;
      }): Promise<{
        data: {
          commits: Array<{
            sha: string;
            author?: { login?: string } | null;
            commit: { author?: { name?: string } | null };
          }>;
        };
      }>;
      listCommits(params: {
        owner: string;
        repo: string;
        sha: string;
        per_page: number;
      }): Promise<{
        data: Array<{
          sha: string;
          author?: { login?: string } | null;
          commit: { author?: { name?: string } | null };
        }>;
      }>;
    };
  };
}

function extractAuthors(
  commits: Array<{
    sha: string;
    author?: { login?: string } | null;
    commit: { author?: { name?: string } | null };
  }>
): string[] {
  return [
    ...new Set(commits.map((c) => c.author?.login ?? c.commit.author?.name ?? "unknown")),
  ];
}

/**
 * Fetch the commits associated with a release by comparing it to the previous tag.
 *
 * Strategy:
 * 1. List tags (newest-first) and locate the current tag.
 * 2. If a prior tag exists, call compareCommitsWithBasehead for a precise diff.
 * 3. If no prior tag, fall back to listCommits on the current tag ref.
 * 4. On any API error, log a warning and return undefined (best-effort, never fatal).
 */
export async function fetchReleaseCommits(
  octokit: OctokitLike,
  repo: Repo,
  tag: string,
  logger: Logger
): Promise<CommitMetadata | undefined> {
  try {
    const { data: tags } = await octokit.rest.repos.listTags({
      owner: repo.owner,
      repo: repo.repo,
      per_page: 100,
    });

    const tagIndex = tags.findIndex((t) => t.name === tag);

    if (tagIndex !== -1 && tagIndex + 1 < tags.length) {
      const prevTag = tags[tagIndex + 1]!.name;
      const { data: comparison } = await octokit.rest.repos.compareCommitsWithBasehead({
        owner: repo.owner,
        repo: repo.repo,
        basehead: `${prevTag}...${tag}`,
      });

      const commits = comparison.commits;
      return {
        count: commits.length,
        authors: extractAuthors(commits),
        shas: commits.map((c) => c.sha),
      };
    }

    logger.warning(
      `No previous tag found before ${tag}; falling back to listing commits on ${tag}.`
    );
    const { data: commits } = await octokit.rest.repos.listCommits({
      owner: repo.owner,
      repo: repo.repo,
      sha: tag,
      per_page: 100,
    });

    return {
      count: commits.length,
      authors: extractAuthors(commits),
      shas: commits.map((c) => c.sha),
    };
  } catch (err) {
    logger.warning(`Could not fetch release commits: ${(err as Error).message}`);
    return undefined;
  }
}

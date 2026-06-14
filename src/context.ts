/**
 * Utilities for extracting release data from the GitHub Actions event context.
 * Kept free of @actions/core and @actions/github imports so it can be unit-tested
 * without the GitHub Actions runtime.
 */

import type { ActionContext, Release } from "./types.js";

/**
 * Pull a normalized release object out of the event payload.
 *
 * Supports the `release` event (release.body) and falls back gracefully for
 * `push` tag events where no rich release body exists.
 */
export function parseReleaseFromContext(context: ActionContext): {
  release: Release | null;
  body: string;
} {
  const payload = context.payload ?? {};
  const release = payload.release as Record<string, unknown> | undefined;

  if (release) {
    return {
      release: {
        tag: release.tag_name as string,
        name: (release.name as string) || (release.tag_name as string),
        body: (release.body as string) || "",
        isPrerelease: Boolean(release.prerelease),
        isDraft: Boolean(release.draft),
        publishedAt: (release.published_at as string) || null,
        author: release.author
          ? ((release.author as { login: string }).login ?? null)
          : null,
        url: (release.html_url as string) || null,
      },
      body: (release.body as string) || "",
    };
  }

  // Tag push fallback: no release notes, but we can still report the ref.
  const ref = (payload.ref as string | undefined) ?? context.ref ?? "";
  const tag = ref.replace(/^refs\/tags\//, "");
  return {
    release: tag
      ? {
          tag,
          name: tag,
          body: "",
          isPrerelease: false,
          isDraft: false,
          publishedAt: null,
          author: context.actor ?? null,
          url: null,
        }
      : null,
    body: "",
  };
}

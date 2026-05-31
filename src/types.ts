export interface CheckRule {
  id: string;
  label: string;
  test: (body: string, ctx?: Record<string, unknown>) => boolean;
  /** Optional: extract the specific text/references that satisfied this check. */
  extract?: (body: string) => string[];
  /** Regulatory control reference (e.g. "CTRL-1", "A.12.1.2", "CC8.1", "Art.9"). */
  controlRef?: string;
}

export interface CheckResult {
  id: string;
  label: string;
  ok: boolean;
  /** Specific text or references found by this check (populated when available). */
  evidence?: string[];
  /** Regulatory control reference traceable to a specific framework control. */
  controlRef?: string;
}

export interface EvaluateResult {
  passed: boolean;
  score: number;
  total: number;
  results: CheckResult[];
}

export interface Release {
  tag: string;
  name: string;
  body: string;
  isPrerelease: boolean;
  isDraft: boolean;
  publishedAt: string | null;
  author: string | null;
  url: string | null;
}

export interface Repo {
  owner: string;
  repo: string;
}

export interface Logger {
  info: (message: string) => void;
  warning: (message: string) => void;
  debug: (message: string) => void;
}

export interface ActionContext {
  payload: Record<string, unknown>;
  actor?: string;
  ref?: string;
  repo?: Repo;
}

export type ComplianceProfile = "default" | "iso27001" | "soc2" | "dora";

/** Commit metadata fetched from the GitHub API for a release. */
export interface CommitMetadata {
  /** Number of commits in this release. */
  count: number;
  /** Unique committer logins (or names when login is unavailable). */
  authors: string[];
  /** Full commit SHAs for traceability. */
  shas: string[];
}

/**
 * A durable, machine-readable record of a single release compliance evaluation.
 *
 * This is the free-tier "audit evidence" artifact: a schema-versioned, timestamped
 * snapshot that auditors can archive (e.g. as a CI artifact) to prove a release was
 * checked against the compliance checklist at publish time.
 */
export interface ComplianceReport {
  /** Schema version of this report shape (independent of the tool version). */
  schemaVersion: string;
  /** ISO-8601 timestamp of when the report was generated. */
  generatedAt: string;
  /** The tool that produced the report. */
  tool: {
    name: string;
    version: string;
  };
  /** Which tier produced the evaluation. */
  tier: "free" | "premium";
  /** Compliance framework the checklist was evaluated against. */
  profile: ComplianceProfile;
  /** `owner/repo` the release belongs to. */
  repository: string;
  release: {
    tag: string;
    name: string;
    isPrerelease: boolean;
    isDraft: boolean;
    publishedAt: string | null;
    author: string | null;
    url: string | null;
  };
  compliance: {
    passed: boolean;
    score: number;
    total: number;
    checks: CheckResult[];
  };
  /** Commit metadata fetched from the GitHub API (populated on release events). */
  commits?: CommitMetadata;
  /**
   * Path to the custom rules file that was active during evaluation.
   * When set, this field makes the audit trail complete: auditors can trace
   * exactly which org-specific controls contributed to the compliance result.
   */
  customRulesPath?: string;
  /**
   * SHA-256 hex digest of the canonical JSON of all fields except this one.
   * Lets auditors verify the artifact has not been modified after generation.
   */
  integrityHash?: string;
}

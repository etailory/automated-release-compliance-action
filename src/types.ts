export interface CheckRule {
  id: string;
  label: string;
  test: (body: string, ctx?: Record<string, unknown>) => boolean;
  /** Optional: extract the specific text/references that satisfied this check. */
  extract?: (body: string) => string[];
}

export interface CheckResult {
  id: string;
  label: string;
  ok: boolean;
  /** Specific text or references found by this check (populated when available). */
  evidence?: string[];
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

export interface AuditPayload {
  schemaVersion: string;
  repository: string;
  release: {
    tag: string;
    name: string;
    isPrerelease: boolean;
    isDraft: boolean;
    publishedAt: string | null;
    author: string | null;
  };
  requested: {
    isoControlMapping: boolean;
    evidencePdf: boolean;
    governanceVerdict: boolean;
  };
}

export interface DispatchResult {
  status: string;
  queued: boolean;
  jobId?: string;
}

export interface PremiumAuditResult {
  prepared: boolean;
  endpoint: string;
  payload: AuditPayload;
  jobId?: string;
}

export interface ActionContext {
  payload: Record<string, unknown>;
  actor?: string;
  ref?: string;
  repo?: Repo;
}

export type ComplianceProfile = "default" | "iso27001" | "soc2" | "dora";

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
}

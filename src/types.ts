export interface CheckRule {
  id: string;
  label: string;
  test: (body: string, ctx?: Record<string, unknown>) => boolean;
}

export interface CheckResult {
  id: string;
  label: string;
  ok: boolean;
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
}

export interface PremiumAuditResult {
  prepared: boolean;
  endpoint: string;
  payload: AuditPayload;
}

export interface ActionContext {
  payload: Record<string, unknown>;
  actor?: string;
  ref?: string;
  repo?: Repo;
}

export type ComplianceProfile = "default" | "iso27001" | "soc2" | "dora";

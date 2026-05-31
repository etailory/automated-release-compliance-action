import { test, expect, beforeEach, afterEach } from "bun:test";

import {
  dispatchToBackend,
  runPremiumAudit,
  buildAuditPayload,
  getAuditEndpoint,
} from "../src/premium.js";
import type { AuditPayload, Release, Repo, Logger } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLE_PAYLOAD: AuditPayload = {
  schemaVersion: "1.0",
  repository: "acme/widgets",
  release: {
    tag: "v1.0.0",
    name: "GA",
    isPrerelease: false,
    isDraft: false,
    publishedAt: "2026-05-31T00:00:00Z",
    author: "octocat",
  },
  requested: { isoControlMapping: true, evidencePdf: true, governanceVerdict: true },
};

const SAMPLE_RELEASE: Release = {
  tag: "v1.0.0",
  name: "GA",
  body: "Fixed the billing bug. See #42 for details.",
  isPrerelease: false,
  isDraft: false,
  publishedAt: "2026-05-31T00:00:00Z",
  author: "octocat",
  url: null,
};

const SAMPLE_REPO: Repo = { owner: "acme", repo: "widgets" };

function makeLogger(): Logger & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    info: (m) => messages.push(`info: ${m}`),
    warning: (m) => messages.push(`warn: ${m}`),
    debug: (m) => messages.push(`debug: ${m}`),
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown: isolate env var and global fetch between tests
// ---------------------------------------------------------------------------

let savedBackendUrl: string | undefined;
let savedFetch: typeof globalThis.fetch;

beforeEach(() => {
  savedBackendUrl = process.env.COMPLIANCE_BACKEND_URL;
  savedFetch = globalThis.fetch;
  delete process.env.COMPLIANCE_BACKEND_URL;
  delete process.env.COMPLIANCE_REQUEST_TIMEOUT_MS;
});

afterEach(() => {
  if (savedBackendUrl === undefined) {
    delete process.env.COMPLIANCE_BACKEND_URL;
  } else {
    process.env.COMPLIANCE_BACKEND_URL = savedBackendUrl;
  }
  globalThis.fetch = savedFetch;
});

// ---------------------------------------------------------------------------
// getAuditEndpoint
// ---------------------------------------------------------------------------

test("getAuditEndpoint returns null when COMPLIANCE_BACKEND_URL is unset", () => {
  expect(getAuditEndpoint()).toBeNull();
});

test("getAuditEndpoint returns full audit URL when COMPLIANCE_BACKEND_URL is set", () => {
  process.env.COMPLIANCE_BACKEND_URL = "https://backend.example.com";
  expect(getAuditEndpoint()).toBe("https://backend.example.com/api/v1/compliance/audit");
});

test("getAuditEndpoint strips trailing slash from base URL", () => {
  process.env.COMPLIANCE_BACKEND_URL = "https://backend.example.com/";
  expect(getAuditEndpoint()).toBe("https://backend.example.com/api/v1/compliance/audit");
});

// ---------------------------------------------------------------------------
// dispatchToBackend — stub path
// ---------------------------------------------------------------------------

test("dispatchToBackend returns stubbed result when COMPLIANCE_BACKEND_URL is unset", async () => {
  const result = await dispatchToBackend("key-123", SAMPLE_PAYLOAD);
  expect(result.status).toBe("stubbed");
  expect(result.queued).toBe(false);
  expect(result.jobId).toBeUndefined();
});

// ---------------------------------------------------------------------------
// dispatchToBackend — success path (HTTP 202)
// ---------------------------------------------------------------------------

test("dispatchToBackend returns queued result with jobId on HTTP 202", async () => {
  process.env.COMPLIANCE_BACKEND_URL = "https://backend.example.com";

  globalThis.fetch = async (_url: RequestInfo | URL, _opts?: RequestInit) =>
    new Response(JSON.stringify({ jobId: "audit-job-001", status: "queued" }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });

  const result = await dispatchToBackend("license-abc", SAMPLE_PAYLOAD);

  expect(result.status).toBe("queued");
  expect(result.queued).toBe(true);
  expect(result.jobId).toBe("audit-job-001");
});

test("dispatchToBackend sends Authorization Bearer header", async () => {
  process.env.COMPLIANCE_BACKEND_URL = "https://backend.example.com";

  let capturedAuthHeader: string | null = null;
  globalThis.fetch = async (_url: RequestInfo | URL, opts?: RequestInit) => {
    capturedAuthHeader =
      (opts?.headers as Record<string, string>)?.["Authorization"] ?? null;
    return new Response(JSON.stringify({ jobId: "job-x" }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  };

  await dispatchToBackend("my-secret-key", SAMPLE_PAYLOAD);

  expect(capturedAuthHeader).toBe("Bearer my-secret-key");
});

test("dispatchToBackend POSTs the payload as JSON to the correct URL", async () => {
  process.env.COMPLIANCE_BACKEND_URL = "https://backend.example.com";

  let capturedUrl: string | null = null;
  let capturedBody: unknown = null;
  globalThis.fetch = async (url: RequestInfo | URL, opts?: RequestInit) => {
    capturedUrl = url.toString();
    capturedBody = opts?.body ? JSON.parse(opts.body as string) : null;
    return new Response(JSON.stringify({ jobId: "job-y" }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  };

  await dispatchToBackend("key", SAMPLE_PAYLOAD);

  expect(capturedUrl).toBe("https://backend.example.com/api/v1/compliance/audit");
  expect((capturedBody as AuditPayload).repository).toBe("acme/widgets");
});

// ---------------------------------------------------------------------------
// dispatchToBackend — non-2xx error paths
// ---------------------------------------------------------------------------

test("dispatchToBackend throws a descriptive error on HTTP 401", async () => {
  process.env.COMPLIANCE_BACKEND_URL = "https://backend.example.com";

  globalThis.fetch = async () =>
    new Response("Unauthorized: invalid license key", { status: 401 });

  await expect(dispatchToBackend("bad-key", SAMPLE_PAYLOAD)).rejects.toThrow(
    /HTTP 401/
  );
});

test("dispatchToBackend throws a descriptive error on HTTP 500", async () => {
  process.env.COMPLIANCE_BACKEND_URL = "https://backend.example.com";

  globalThis.fetch = async () =>
    new Response("Internal server error", { status: 500 });

  await expect(dispatchToBackend("key", SAMPLE_PAYLOAD)).rejects.toThrow(
    /HTTP 500/
  );
});

test("dispatchToBackend error message includes response body text", async () => {
  process.env.COMPLIANCE_BACKEND_URL = "https://backend.example.com";

  globalThis.fetch = async () =>
    new Response("License quota exceeded", { status: 429 });

  let errorMessage = "";
  try {
    await dispatchToBackend("key", SAMPLE_PAYLOAD);
  } catch (e) {
    errorMessage = (e as Error).message;
  }
  expect(errorMessage).toContain("License quota exceeded");
});

// ---------------------------------------------------------------------------
// runPremiumAudit
// ---------------------------------------------------------------------------

test("runPremiumAudit warns and skips transmission when COMPLIANCE_BACKEND_URL is unset", async () => {
  const logger = makeLogger();
  const result = await runPremiumAudit({
    licenseKey: "key-123",
    release: SAMPLE_RELEASE,
    repo: SAMPLE_REPO,
    logger,
  });

  expect(result.prepared).toBe(true);
  expect(result.jobId).toBeUndefined();
  expect(logger.messages.some((m) => m.includes("warn") && m.includes("COMPLIANCE_BACKEND_URL"))).toBe(true);
});

test("runPremiumAudit logs jobId when backend returns 202", async () => {
  process.env.COMPLIANCE_BACKEND_URL = "https://backend.example.com";

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ jobId: "audit-xyz" }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });

  const logger = makeLogger();
  const result = await runPremiumAudit({
    licenseKey: "key-abc",
    release: SAMPLE_RELEASE,
    repo: SAMPLE_REPO,
    logger,
  });

  expect(result.jobId).toBe("audit-xyz");
  expect(logger.messages.some((m) => m.includes("jobId=audit-xyz"))).toBe(true);
});

test("runPremiumAudit throws when called without a license key", async () => {
  const logger = makeLogger();
  await expect(
    runPremiumAudit({
      licenseKey: "",
      release: SAMPLE_RELEASE,
      repo: SAMPLE_REPO,
      logger,
    })
  ).rejects.toThrow(/license key/);
});

test("runPremiumAudit propagates backend errors", async () => {
  process.env.COMPLIANCE_BACKEND_URL = "https://backend.example.com";

  globalThis.fetch = async () => new Response("Service unavailable", { status: 503 });

  const logger = makeLogger();
  await expect(
    runPremiumAudit({
      licenseKey: "key",
      release: SAMPLE_RELEASE,
      repo: SAMPLE_REPO,
      logger,
    })
  ).rejects.toThrow(/HTTP 503/);
});

// ---------------------------------------------------------------------------
// buildAuditPayload (sanity check, also tested in checklist.test.ts)
// ---------------------------------------------------------------------------

test("buildAuditPayload includes all required fields", () => {
  const payload = buildAuditPayload(SAMPLE_RELEASE, SAMPLE_REPO);
  expect(payload.schemaVersion).toBe("1.0");
  expect(payload.repository).toBe("acme/widgets");
  expect(payload.release.tag).toBe("v1.0.0");
  expect(payload.requested.isoControlMapping).toBe(true);
});

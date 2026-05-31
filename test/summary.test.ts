import { test, expect } from "bun:test";

import { buildJobSummary } from "../src/summary.js";
import type { SummaryBuilder, SummaryParams } from "../src/summary.js";
import type { Release, Repo } from "../src/types.js";

/** Captures all calls made to the summary builder for assertion. */
class MockSummaryBuilder implements SummaryBuilder {
  headings: Array<{ text: string; level: number | string | undefined }> = [];
  tables: Array<Array<Array<{ data: string; header?: boolean } | string>>> = [];
  rawParts: string[] = [];
  written = false;

  addHeading(text: string, level?: number | string): this {
    this.headings.push({ text, level });
    return this;
  }

  addTable(rows: Array<Array<{ data: string; header?: boolean } | string>>): this {
    this.tables.push(rows);
    return this;
  }

  addRaw(text: string): this {
    this.rawParts.push(text);
    return this;
  }

  write(): Promise<this> {
    this.written = true;
    return Promise.resolve(this);
  }
}

const REPO: Repo = { owner: "acme", repo: "widgets" };

const RELEASE: Release = {
  tag: "v1.2.0",
  name: "Spring Release",
  body: "fix the login regression",
  isPrerelease: false,
  isDraft: false,
  publishedAt: "2026-05-30T00:00:00Z",
  author: "octocat",
  url: "https://example.com/r",
};

const BASE_PARAMS: SummaryParams = {
  repo: REPO,
  release: RELEASE,
  evaluation: {
    passed: true,
    score: 3,
    total: 3,
    results: [
      { id: "has-description", label: "Has description", ok: true },
      { id: "references-issue", label: "References issue", ok: true },
      { id: "has-changelog", label: "Has changelog", ok: true },
    ],
  },
  profile: "default",
  tier: "free",
  generatedAt: "2026-05-31T12:00:00.000Z",
};

test("buildJobSummary calls write()", async () => {
  const mock = new MockSummaryBuilder();
  await buildJobSummary(BASE_PARAMS, mock);
  expect(mock.written).toBe(true);
});

test("buildJobSummary includes repo name in header table", async () => {
  const mock = new MockSummaryBuilder();
  await buildJobSummary(BASE_PARAMS, mock);

  const headerTable = mock.tables[0]!;
  const allCells = headerTable.flat();
  expect(allCells).toContain("acme/widgets");
});

test("buildJobSummary includes release tag in header table", async () => {
  const mock = new MockSummaryBuilder();
  await buildJobSummary(BASE_PARAMS, mock);

  const headerTable = mock.tables[0]!;
  const allCells = headerTable.flat();
  expect(allCells.some((c) => typeof c === "string" && c.includes("v1.2.0"))).toBe(true);
});

test("buildJobSummary includes compliance profile in header table", async () => {
  const mock = new MockSummaryBuilder();
  await buildJobSummary({ ...BASE_PARAMS, profile: "iso27001" }, mock);

  const headerTable = mock.tables[0]!;
  const allCells = headerTable.flat();
  expect(allCells.some((c) => typeof c === "string" && c.includes("iso27001"))).toBe(true);
});

test("buildJobSummary includes timestamp in header table", async () => {
  const mock = new MockSummaryBuilder();
  await buildJobSummary(BASE_PARAMS, mock);

  const headerTable = mock.tables[0]!;
  const allCells = headerTable.flat();
  expect(allCells).toContain("2026-05-31T12:00:00.000Z");
});

test("buildJobSummary writes a checklist results table with Status/Check/Notes columns", async () => {
  const mock = new MockSummaryBuilder();
  await buildJobSummary(BASE_PARAMS, mock);

  // Second table is the checklist results
  const resultsTable = mock.tables[1]!;
  const headerRow = resultsTable[0]!;
  const headerCells = headerRow.map((c) => (typeof c === "string" ? c : c.data));
  expect(headerCells).toContain("Status");
  expect(headerCells).toContain("Check");
  expect(headerCells).toContain("Notes");
});

test("buildJobSummary maps pass/fail icons correctly", async () => {
  const mock = new MockSummaryBuilder();
  const params: SummaryParams = {
    ...BASE_PARAMS,
    evaluation: {
      passed: false,
      score: 1,
      total: 2,
      results: [
        { id: "a", label: "Passes", ok: true },
        { id: "b", label: "Fails", ok: false },
      ],
    },
  };
  await buildJobSummary(params, mock);

  const resultsTable = mock.tables[1]!;
  // Row at index 1 (skip header) should be pass
  expect(resultsTable[1]![0]).toBe("✅");
  // Row at index 2 should be fail
  expect(resultsTable[2]![0]).toBe("❌");
});

test("buildJobSummary includes notes/evidence when present", async () => {
  const mock = new MockSummaryBuilder();
  const params: SummaryParams = {
    ...BASE_PARAMS,
    evaluation: {
      passed: true,
      score: 1,
      total: 1,
      results: [
        { id: "a", label: "Has evidence", ok: true, evidence: ["ref #42", "ref #43"] },
      ],
    },
  };
  await buildJobSummary(params, mock);

  const resultsTable = mock.tables[1]!;
  const notesCell = resultsTable[1]![2];
  expect(typeof notesCell === "string" && notesCell.includes("ref #42")).toBe(true);
  expect(typeof notesCell === "string" && notesCell.includes("ref #43")).toBe(true);
});

test("buildJobSummary notes are empty string when no evidence", async () => {
  const mock = new MockSummaryBuilder();
  await buildJobSummary(BASE_PARAMS, mock);

  const resultsTable = mock.tables[1]!;
  // All data rows should have an empty string for notes (no evidence on fixtures)
  for (let i = 1; i < resultsTable.length; i++) {
    expect(resultsTable[i]![2]).toBe("");
  }
});

test("buildJobSummary footer includes score and tier", async () => {
  const mock = new MockSummaryBuilder();
  await buildJobSummary(BASE_PARAMS, mock);

  const footer = mock.rawParts.join("\n");
  expect(footer).toContain("3/3");
  expect(footer).toContain("free");
});

test("buildJobSummary footer shows ❌ when not passed", async () => {
  const mock = new MockSummaryBuilder();
  const params: SummaryParams = {
    ...BASE_PARAMS,
    evaluation: { passed: false, score: 0, total: 3, results: [] },
  };
  await buildJobSummary(params, mock);

  const footer = mock.rawParts.join("\n");
  expect(footer).toContain("❌");
  expect(footer).toContain("0/3");
});

test("buildJobSummary omits artifact note when reportPath is absent", async () => {
  const mock = new MockSummaryBuilder();
  await buildJobSummary(BASE_PARAMS, mock);

  const all = mock.rawParts.join("\n");
  expect(all).not.toContain("Artifact");
});

test("buildJobSummary includes artifact path when reportPath is set", async () => {
  const mock = new MockSummaryBuilder();
  await buildJobSummary(
    { ...BASE_PARAMS, reportPath: "compliance-reports/report.json" },
    mock
  );

  const all = mock.rawParts.join("\n");
  expect(all).toContain("compliance-reports/report.json");
  expect(all).toContain("Artifact");
});

test("buildJobSummary emits two headings (main + checklist)", async () => {
  const mock = new MockSummaryBuilder();
  await buildJobSummary(BASE_PARAMS, mock);

  expect(mock.headings.length).toBe(2);
  expect(mock.headings[0]!.text).toBe("Release Compliance Report");
  expect(mock.headings[1]!.text).toBe("Checklist Results");
});

test("buildJobSummary uses premium tier label in footer", async () => {
  const mock = new MockSummaryBuilder();
  await buildJobSummary({ ...BASE_PARAMS, tier: "premium" }, mock);

  const footer = mock.rawParts.join("\n");
  expect(footer).toContain("premium");
});

test("buildJobSummary omits integrity line when integrityHash is absent", async () => {
  const mock = new MockSummaryBuilder();
  await buildJobSummary(BASE_PARAMS, mock);

  const all = mock.rawParts.join("\n");
  expect(all).not.toContain("Integrity");
  expect(all).not.toContain("sha256:");
});

test("buildJobSummary shows sha256 hash in footer when integrityHash is provided", async () => {
  const mock = new MockSummaryBuilder();
  const hash = "a".repeat(64);
  await buildJobSummary({ ...BASE_PARAMS, integrityHash: hash }, mock);

  const all = mock.rawParts.join("\n");
  expect(all).toContain(`sha256:${hash}`);
  expect(all).toContain("Integrity");
});

test("buildJobSummary integrity line appears after artifact line when both are set", async () => {
  const mock = new MockSummaryBuilder();
  const hash = "b".repeat(64);
  await buildJobSummary(
    { ...BASE_PARAMS, reportPath: "reports/report.json", integrityHash: hash },
    mock
  );

  const all = mock.rawParts.join("\n");
  const artifactIdx = all.indexOf("Artifact");
  const integrityIdx = all.indexOf("Integrity");
  expect(artifactIdx).toBeGreaterThanOrEqual(0);
  expect(integrityIdx).toBeGreaterThan(artifactIdx);
});

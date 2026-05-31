import { test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { loadCustomRules } from "../src/custom-rules.js";

const TMP_DIR = join(import.meta.dir, "__tmp__");
const tmpFile = (name: string) => join(TMP_DIR, name);

beforeAll(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  // Clean up temp files
  try { unlinkSync(tmpFile("valid.json")); } catch {}
  try { unlinkSync(tmpFile("malformed.json")); } catch {}
  try { unlinkSync(tmpFile("not-array.json")); } catch {}
  try { unlinkSync(tmpFile("missing-id.json")); } catch {}
  try { unlinkSync(tmpFile("missing-label.json")); } catch {}
  try { unlinkSync(tmpFile("no-control-ref.json")); } catch {}
});

test("valid JSON file loads and produces expected CheckRule array", () => {
  writeFileSync(
    tmpFile("valid.json"),
    JSON.stringify([
      { id: "custom-1", label: "Must mention data-retention", pattern: "data[- ]retention", controlRef: "ORG-1" },
      { id: "custom-2", label: "Must mention approval", pattern: "approved by" },
    ])
  );

  const rules = loadCustomRules(tmpFile("valid.json"));

  expect(rules).toHaveLength(2);
  expect(rules[0].id).toBe("custom-1");
  expect(rules[0].label).toBe("Must mention data-retention");
  expect(rules[0].controlRef).toBe("ORG-1");
  expect(rules[1].id).toBe("custom-2");
  expect(rules[1].controlRef).toBeUndefined();
});

test("test() function of a loaded rule matches and rejects body strings", () => {
  writeFileSync(
    tmpFile("valid.json"),
    JSON.stringify([
      { id: "custom-1", label: "Must mention data-retention", pattern: "data[- ]retention" },
    ])
  );

  const rules = loadCustomRules(tmpFile("valid.json"));
  expect(rules[0].test("This release enforces data-retention policies.")).toBe(true);
  expect(rules[0].test("This release enforces data retention policies.")).toBe(true);
  expect(rules[0].test("Nothing relevant here.")).toBe(false);
});

test("test() function is case-insensitive", () => {
  writeFileSync(
    tmpFile("valid.json"),
    JSON.stringify([{ id: "r1", label: "Has approval", pattern: "approved by" }])
  );

  const rules = loadCustomRules(tmpFile("valid.json"));
  expect(rules[0].test("APPROVED BY the security team")).toBe(true);
  expect(rules[0].test("Approved By manager")).toBe(true);
});

test("missing file throws a descriptive error", () => {
  expect(() => loadCustomRules(tmpFile("does-not-exist.json"))).toThrow(
    /custom-rules-path: cannot read file/
  );
});

test("malformed JSON throws a descriptive error", () => {
  writeFileSync(tmpFile("malformed.json"), "{ not valid json }");
  expect(() => loadCustomRules(tmpFile("malformed.json"))).toThrow(
    /custom-rules-path:.*is not valid JSON/
  );
});

test("non-array JSON throws a descriptive error", () => {
  writeFileSync(tmpFile("not-array.json"), JSON.stringify({ id: "x", label: "y", pattern: "z" }));
  expect(() => loadCustomRules(tmpFile("not-array.json"))).toThrow(
    /custom-rules-path:.*must contain a JSON array/
  );
});

test("rule missing 'id' throws a descriptive error", () => {
  writeFileSync(
    tmpFile("missing-id.json"),
    JSON.stringify([{ label: "Has approval", pattern: "approved by" }])
  );
  expect(() => loadCustomRules(tmpFile("missing-id.json"))).toThrow(
    /missing a required string "id" field/
  );
});

test("rule missing 'label' throws a descriptive error", () => {
  writeFileSync(
    tmpFile("missing-label.json"),
    JSON.stringify([{ id: "r1", pattern: "approved by" }])
  );
  expect(() => loadCustomRules(tmpFile("missing-label.json"))).toThrow(
    /missing a required string "label" field/
  );
});

test("rule missing 'pattern' throws a descriptive error", () => {
  writeFileSync(
    tmpFile("missing-label.json"),
    JSON.stringify([{ id: "r1", label: "Has approval" }])
  );
  expect(() => loadCustomRules(tmpFile("missing-label.json"))).toThrow(
    /missing a required string "pattern" field/
  );
});

test("rule with optional controlRef is loaded correctly", () => {
  writeFileSync(
    tmpFile("no-control-ref.json"),
    JSON.stringify([{ id: "r1", label: "Some rule", pattern: "foo" }])
  );
  const rules = loadCustomRules(tmpFile("no-control-ref.json"));
  expect(rules[0].controlRef).toBeUndefined();
});

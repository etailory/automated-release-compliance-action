import { readFileSync } from "node:fs";
import type { CheckRule } from "./types.js";

export function loadCustomRules(filePath: string): CheckRule[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(
      `custom-rules-path: cannot read file "${filePath}": ${(err as Error).message}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `custom-rules-path: "${filePath}" is not valid JSON: ${(err as Error).message}`
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `custom-rules-path: "${filePath}" must contain a JSON array of rule objects.`
    );
  }

  return parsed.map((item: unknown, index: number) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`custom-rules-path: rule at index ${index} must be an object.`);
    }
    const rule = item as Record<string, unknown>;

    if (typeof rule.id !== "string" || rule.id.trim() === "") {
      throw new Error(
        `custom-rules-path: rule at index ${index} is missing a required string "id" field.`
      );
    }
    if (typeof rule.label !== "string" || rule.label.trim() === "") {
      throw new Error(
        `custom-rules-path: rule at index ${index} is missing a required string "label" field.`
      );
    }
    if (typeof rule.pattern !== "string" || rule.pattern.trim() === "") {
      throw new Error(
        `custom-rules-path: rule at index ${index} is missing a required string "pattern" field.`
      );
    }

    let regex: RegExp;
    try {
      regex = new RegExp(rule.pattern, "i");
    } catch (err) {
      throw new Error(
        `custom-rules-path: rule "${rule.id}" has an invalid regex pattern "${rule.pattern}": ${(err as Error).message}`
      );
    }

    const checkRule: CheckRule = {
      id: rule.id,
      label: rule.label,
      test: (body: string) => regex.test(body),
    };

    if (typeof rule.controlRef === "string" && rule.controlRef.trim() !== "") {
      checkRule.controlRef = rule.controlRef;
    }

    return checkRule;
  });
}

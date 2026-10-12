import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detects, loadCases, type Detector } from "../src/policy/eval-case";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "evalcase-"));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), c);
  }
  return root;
}
const fakeLint = (ids: string[]): Detector => ({ lint: async () => ids });

describe("eval cases", () => {
  it("loads a lint case and detects when the rule fires", async () => {
    const root = tree({
      "factory/evals/error-format/case.yml":
        "kind: lint\ncategory: review:error-format\nfixture: fixture.ts\nasPath: apps/api/src/routes/__eval__.ts\nrule: no-restricted-syntax\n",
      "factory/evals/error-format/fixture.ts": "export const x = 1;\n",
    });
    const { cases, errors } = loadCases(root);
    expect(errors).toEqual([]);
    expect(await detects(root, cases[0]!, fakeLint(["no-restricted-syntax"]))).toBe(true);
    expect(await detects(root, cases[0]!, fakeLint(["no-unused-vars"]))).toBe(false);
  });

  it("checks prompt-contains against the tree's file after NFKC normalization", async () => {
    const root = tree({
      "AGENTS.md": "API 오류는 errors.ts 헬퍼만 사용한다.\n",
      "factory/evals/agents-rule/case.yml":
        "kind: prompt-contains\ncategory: review:error-format\nfile: AGENTS.md\ntext: API 오류는 errors.ts 헬퍼만 사용한다\n",
    });
    const { cases } = loadCases(root);
    expect(await detects(root, cases[0]!, fakeLint([]))).toBe(true);
  });

  it("rejects bad slugs, unknown kinds, unsafe paths, missing and symlinked fixtures", () => {
    const root = tree({
      "factory/evals/Bad_Slug/case.yml": "kind: lint\n",
      "factory/evals/unknown/case.yml": "kind: vitest\ncategory: x\n",
      "factory/evals/escape/case.yml":
        "kind: lint\ncategory: x\nfixture: f.ts\nasPath: ../outside.ts\nrule: r\n",
      "factory/evals/missing/case.yml":
        "kind: lint\ncategory: x\nfixture: nope.ts\nasPath: apps/a.ts\nrule: r\n",
      "factory/evals/link/case.yml":
        "kind: lint\ncategory: x\nfixture: f.ts\nasPath: apps/a.ts\nrule: r\n",
    });
    symlinkSync("/etc/hosts", path.join(root, "factory/evals/link/f.ts"));
    const { cases, errors } = loadCases(root);
    expect(cases).toEqual([]);
    expect(errors).toHaveLength(5);
  });

  it("rejects oversized fixtures and returns false when the prompt file is missing", async () => {
    const root = tree({
      "factory/evals/big/case.yml":
        "kind: lint\ncategory: x\nfixture: f.ts\nasPath: apps/a.ts\nrule: r\n",
      "factory/evals/big/f.ts": "a".repeat(20 * 1024 + 1),
      "factory/evals/nofile/case.yml":
        "kind: prompt-contains\ncategory: x\nfile: AGENTS.md\ntext: 열 글자 이상의 텍스트입니다\n",
    });
    const { cases, errors } = loadCases(root);
    expect(errors).toHaveLength(1);
    expect(await detects(root, cases[0]!, fakeLint([]))).toBe(false);
  });
});

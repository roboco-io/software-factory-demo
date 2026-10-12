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

  it("does not follow a symlinked prompt file or parent dir in detects", async () => {
    const outside = tree({ "secret.md": "열 글자 이상의 비밀 텍스트입니다" });
    const root = tree({
      "factory/evals/a/case.yml":
        "kind: prompt-contains\ncategory: x\nfile: AGENTS.md\ntext: 열 글자 이상의 비밀 텍스트입니다\n",
      "factory/evals/b/case.yml":
        "kind: prompt-contains\ncategory: x\nfile: factory/prompts/p.md\ntext: 열 글자 이상의 비밀 텍스트입니다\n",
    });
    symlinkSync(path.join(outside, "secret.md"), path.join(root, "AGENTS.md"));
    symlinkSync(outside, path.join(root, "factory/prompts"));
    const { cases, errors } = loadCases(root);
    expect(errors).toEqual([]);
    expect(cases).toHaveLength(2);
    for (const c of cases) expect(await detects(root, c, fakeLint([]))).toBe(false);
  });

  it("reports symlinked case.yml and symlinked slug dirs in errors", () => {
    const outside = tree({
      "case.yml": "kind: lint\ncategory: x\nfixture: f.ts\nasPath: apps/a.ts\nrule: r\n",
    });
    const root = tree({ "factory/evals/real/f.ts": "x" });
    mkdirSync(path.join(root, "factory/evals/ymllink"), { recursive: true });
    symlinkSync(path.join(outside, "case.yml"), path.join(root, "factory/evals/ymllink/case.yml"));
    symlinkSync(outside, path.join(root, "factory/evals/dirlink"));
    const { cases, errors } = loadCases(root);
    expect(cases).toEqual([]);
    expect(errors.some((e) => e.startsWith("ymllink:"))).toBe(true);
    expect(errors.some((e) => e.startsWith("dirlink:"))).toBe(true);
  });

  it("reports a symlinked factory/evals or factory dir and loads no cases", () => {
    const outside = tree({
      "x/case.yml": "kind: lint\ncategory: x\nfixture: f.ts\nasPath: apps/a.ts\nrule: r\n",
      "x/f.ts": "x",
    });
    const root = tree({ "factory/keep": "" });
    symlinkSync(outside, path.join(root, "factory/evals"));
    const r1 = loadCases(root);
    expect(r1.cases).toEqual([]);
    expect(r1.errors).toHaveLength(1);

    const root2 = mkdtempSync(path.join(tmpdir(), "evalcase-"));
    symlinkSync(tree({ "evals/x/case.yml": "kind: lint\n" }), path.join(root2, "factory"));
    const r2 = loadCases(root2);
    expect(r2.cases).toEqual([]);
    expect(r2.errors).toHaveLength(1);
  });

  it("rejects oversized case.yml", () => {
    const root = tree({ "factory/evals/big/case.yml": "# " + "a".repeat(20 * 1024) });
    const { cases, errors } = loadCases(root);
    expect(cases).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("rejects absolute and backslash asPath", () => {
    const root = tree({
      "factory/evals/abs/case.yml":
        "kind: lint\ncategory: x\nfixture: f.ts\nasPath: /abs.ts\nrule: r\n",
      "factory/evals/bs/case.yml":
        'kind: lint\ncategory: x\nfixture: f.ts\nasPath: "a\\\\b.ts"\nrule: r\n',
      "factory/evals/abs/f.ts": "x",
      "factory/evals/bs/f.ts": "x",
    });
    const { cases, errors } = loadCases(root);
    expect(cases).toEqual([]);
    expect(errors).toHaveLength(2);
  });
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Detector } from "../src/policy/eval-case";
import {
  eslintDetector,
  judgeEval,
  renderEvalText,
  runEval,
  runEvalPlan,
  type EvalPlan,
} from "../src/stages/eval";
import { makeTestDeps, openBotPr } from "./helpers";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "eval-"));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), c);
  }
  return root;
}

const fakeEslint: Detector = {
  lint: async (root, text) => {
    const f = path.join(root, "eslint-rules.txt");
    if (!existsSync(f) || !text.includes("VIOLATION")) return [];
    return readFileSync(f, "utf8").split("\n").filter(Boolean);
  },
};
const lintCase =
  "kind: lint\ncategory: review:error-format\nfixture: f.ts\nasPath: apps/api/src/x.ts\nrule: no-restricted-syntax\n";
const plan = (o: Partial<EvalPlan> = {}): EvalPlan => ({
  pr: 1,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  requireNewCase: true,
  allowDeletion: false,
  reason: "",
  ...o,
});

describe("judgeEval", () => {
  it("passes an improve PR whose new case is missed by base rules and caught by head rules", async () => {
    const base = tree({ "eslint-rules.txt": "" });
    const head = tree({
      "eslint-rules.txt": "no-restricted-syntax\n",
      "factory/evals/ef/case.yml": lintCase,
      "factory/evals/ef/f.ts": "VIOLATION\n",
    });
    const r = await judgeEval(plan(), base, head, fakeEslint);
    expect(r).toMatchObject({ ok: true, newCases: [{ slug: "ef", base: false, head: true }] });
  });

  it("fails when base rules already catch the new case (no evidence the rule changed anything)", async () => {
    const base = tree({ "eslint-rules.txt": "no-restricted-syntax\n" });
    const head = tree({
      "eslint-rules.txt": "no-restricted-syntax\n",
      "factory/evals/ef/case.yml": lintCase,
      "factory/evals/ef/f.ts": "VIOLATION\n",
    });
    expect((await judgeEval(plan(), base, head, fakeEslint)).ok).toBe(false);
  });

  it("fails an improve PR without a new case", async () => {
    const t = tree({ "eslint-rules.txt": "" });
    const r = await judgeEval(plan(), t, tree({ "eslint-rules.txt": "" }), fakeEslint);
    expect(r.ok).toBe(false);
  });

  it("fails any PR that makes an existing case stop being caught (regression)", async () => {
    const files = { "factory/evals/ef/case.yml": lintCase, "factory/evals/ef/f.ts": "VIOLATION\n" };
    const base = tree({ "eslint-rules.txt": "no-restricted-syntax\n", ...files });
    const head = tree({ "eslint-rules.txt": "", ...files }); // 규칙을 지웠다
    const r = await judgeEval(plan({ requireNewCase: false }), base, head, fakeEslint);
    expect(r).toMatchObject({ ok: false, regressions: ["ef"] });
  });

  it("fails a bot PR that deletes a case but lets a human PR delete it", async () => {
    const files = { "factory/evals/ef/case.yml": lintCase, "factory/evals/ef/f.ts": "VIOLATION\n" };
    const base = tree({ "eslint-rules.txt": "no-restricted-syntax\n", ...files });
    const head = tree({ "eslint-rules.txt": "no-restricted-syntax\n" });
    expect((await judgeEval(plan({ requireNewCase: false }), base, head, fakeEslint)).ok).toBe(
      false,
    );
    expect(
      (
        await judgeEval(
          plan({ requireNewCase: false, allowDeletion: true }),
          base,
          head,
          fakeEslint,
        )
      ).ok,
    ).toBe(true);
  });

  it("passes an ordinary PR when there are no cases at all", async () => {
    const t = tree({});
    expect((await judgeEval(plan({ requireNewCase: false }), t, tree({}), fakeEslint)).ok).toBe(
      true,
    );
  });

  it("fails when the head tree has case load errors", async () => {
    const head = tree({ "factory/evals/Bad_Slug/case.yml": "kind: lint\n" });
    const r = await judgeEval(plan({ requireNewCase: false }), tree({}), head, fakeEslint);
    expect(r.ok).toBe(false);
    expect(r.loadErrors).toHaveLength(1);
  });

  it("judges a new prompt-contains case against the base tree's file", async () => {
    const c =
      "kind: prompt-contains\ncategory: review:error-format\nfile: AGENTS.md\ntext: API 오류는 errors.ts 헬퍼만 사용한다\n";
    const base = tree({ "AGENTS.md": "아무 규칙 없음\n" });
    const head = tree({
      "AGENTS.md": "API 오류는 errors.ts 헬퍼만 사용한다.\n",
      "factory/evals/pc/case.yml": c,
    });
    const r = await judgeEval(plan(), base, head, fakeEslint);
    expect(r).toMatchObject({ ok: true, newCases: [{ slug: "pc", base: false, head: true }] });
    expect(renderEvalText(r)).toContain("- pc: base=못 잡음, head=잡음");
  });
});

describe("renderEvalText", () => {
  it("starts with a pass/fail line naming the PR", () => {
    const r = {
      pr: 7,
      ok: false,
      reasons: ["새 케이스가 없다"],
      newCases: [],
      regressions: [],
      deleted: [],
      loadErrors: [],
    };
    const [first, second] = renderEvalText(r).split("\n");
    expect(first).toBe("eval 실패(PR #7)");
    expect(second).toBe("새 케이스가 없다");
  });
});

describe("runEvalPlan", () => {
  const HEAD = "a".repeat(40);
  const BASE = "b".repeat(40);
  async function open(role: "implement" | "improve", author?: string) {
    const h = makeTestDeps();
    const { pr, branch } = await openBotPr(h, { role });
    h.gh.setBranch(branch, HEAD, []);
    if (author) h.gh.pulls.get(pr)!.author = author;
    return { h, pr };
  }

  it("requires a new case for a bot improve PR", async () => {
    const { h, pr } = await open("improve");
    expect(await runEvalPlan(h.deps, { pr, baseSha: BASE, headSha: HEAD })).toMatchObject({
      requireNewCase: true,
      allowDeletion: false,
    });
  });

  it("requires nothing but forbids deletion for a bot implement PR", async () => {
    const { h, pr } = await open("implement");
    expect(await runEvalPlan(h.deps, { pr, baseSha: BASE, headSha: HEAD })).toMatchObject({
      requireNewCase: false,
      allowDeletion: false,
    });
  });

  it("allows deletion for a human PR even if its body carries an improve marker", async () => {
    const { h, pr } = await open("improve", "serithemage");
    expect(await runEvalPlan(h.deps, { pr, baseSha: BASE, headSha: HEAD })).toMatchObject({
      requireNewCase: false,
      allowDeletion: true,
    });
  });

  it("throws when the PR head differs from --sha", async () => {
    const { h, pr } = await open("improve");
    await expect(
      runEvalPlan(h.deps, { pr, baseSha: BASE, headSha: "c".repeat(40) }),
    ).rejects.toThrow(/head/);
  });
});

describe("runEval", () => {
  it("fails without judging when the work tree head differs from the plan", async () => {
    const h = makeTestDeps();
    const calls: string[] = [];
    h.deps.spawn = async (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      return { code: 0, stdout: "c".repeat(40) + "\n", stderr: "" };
    };
    const r = await runEval(h.deps, plan(), tree({}));
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain("다르다");
    expect(calls).toHaveLength(1);
  });

  it("installs dependencies in the head tree, then judges", async () => {
    const h = makeTestDeps();
    const calls: string[] = [];
    h.deps.spawn = async (cmd, args, o) => {
      calls.push(`${cmd} ${args.join(" ")} @${o.cwd}`);
      return { code: 0, stdout: cmd === "git" ? "b".repeat(40) + "\n" : "", stderr: "" };
    };
    const r = await runEval(h.deps, plan({ requireNewCase: false }), tree({}));
    expect(calls[1]).toBe(`pnpm install --frozen-lockfile @${h.deps.settings.workdir}`);
    expect(r.ok).toBe(true);
  });

  it("fails when the install fails", async () => {
    const h = makeTestDeps();
    h.deps.spawn = async (cmd) => ({
      code: cmd === "git" ? 0 : 1,
      stdout: "b".repeat(40),
      stderr: "",
    });
    const r = await runEval(h.deps, plan({ requireNewCase: false }), tree({}));
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain("설치");
  });
});

describe("eslintDetector", () => {
  const root = path.resolve(__dirname, "../../..");
  it("reports no rules for clean text and the ruleId for a violation, using the tree's own config", async () => {
    const d = eslintDetector();
    expect(await d.lint(root, "export const x = 1;\n", "apps/api/src/x.ts")).toEqual([]);
    expect(await d.lint(root, "export const x: any = 1;\n", "apps/api/src/x.ts")).toContain(
      "@typescript-eslint/no-explicit-any",
    );
  }, 60_000);
});

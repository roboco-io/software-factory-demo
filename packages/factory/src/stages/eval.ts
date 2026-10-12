import { createRequire } from "node:module";
import path from "node:path";
import { z } from "zod";
import { scrubEnv } from "../agents/env";
import { detects, loadCases, type Detector, type LoadedCase } from "../policy/eval-case";
import { parsePrMeta } from "../report/pr";
import type { StageDeps } from "./deps";

const SHA = /^[0-9a-f]{40}$/;

// eval-plan job이 만들고 eval job이 job output으로 받는 계획. 받는 쪽은 이 스키마로 다시 검증한다.
export const EvalPlanSchema = z.object({
  pr: z.number().int().positive(),
  baseSha: z.string().regex(SHA),
  headSha: z.string().regex(SHA),
  requireNewCase: z.boolean(), // 봇이 연 개선 PR(meta.role === "improve")
  allowDeletion: z.boolean(), // 봇 PR이 아니면 true
  reason: z.string().max(500),
});
export type EvalPlan = z.infer<typeof EvalPlanSchema>;

export async function runEvalPlan(
  deps: StageDeps,
  args: { pr: number; baseSha: string; headSha: string },
): Promise<EvalPlan> {
  const pull = await deps.gh.getPull(args.pr);
  // 이벤트 이후 head가 바뀌었으면 이 head의 판정은 의미가 없다. 새 head의 실행에 맡긴다.
  if (pull.headSha !== args.headSha) {
    throw new Error(
      `PR #${args.pr}의 head(${pull.headSha})가 판정 대상 ${args.headSha}와 다르다. 새 head의 eval 실행이 판정한다.`,
    );
  }
  // 팩토리 봇이 연 PR만 본문 표식을 신뢰한다(evidence, risk와 같은 기준).
  const meta = pull.author === deps.settings.botLogin ? parsePrMeta(pull.body) : null;
  const make = (requireNewCase: boolean, allowDeletion: boolean, reason: string): EvalPlan =>
    EvalPlanSchema.parse({
      pr: args.pr,
      baseSha: args.baseSha,
      headSha: args.headSha,
      requireNewCase,
      allowDeletion,
      reason,
    });
  if (!meta) {
    return make(
      false,
      true,
      "사람이 연 PR이다. 새 케이스는 요구하지 않고 기존 케이스 회귀만 검사하며, 케이스 삭제는 허용한다.",
    );
  }
  if (meta.role === "improve") {
    return make(
      true,
      false,
      "봇이 연 개선 PR이다. base에서는 못 잡고 head에서는 잡는 새 평가 케이스가 있어야 하고, 케이스 삭제는 허용하지 않는다.",
    );
  }
  return make(
    false,
    false,
    "봇이 연 구현 PR이다. 기존 케이스 회귀만 검사하고, 케이스 삭제는 허용하지 않는다.",
  );
}

export interface EvalResult {
  pr: number;
  ok: boolean;
  reasons: string[];
  newCases: { slug: string; base: boolean; head: boolean }[];
  regressions: string[];
  deleted: string[];
  loadErrors: string[];
}

export async function judgeEval(
  plan: EvalPlan,
  baseRoot: string,
  headRoot: string,
  d: Detector,
): Promise<EvalResult> {
  const reasons: string[] = [];
  const base = loadCases(baseRoot);
  const head = loadCases(headRoot);
  const loadErrors = head.errors;
  if (loadErrors.length > 0) {
    reasons.push(`head의 평가 케이스를 읽지 못했다: ${loadErrors.join("; ")}`);
  }
  // PR 코드(head의 ESLint 설정)를 실행하므로 예외는 실패로 바꾼다(fail closed).
  const safeDetects = async (root: string, c: LoadedCase): Promise<boolean> => {
    try {
      return await detects(root, c, d);
    } catch (e) {
      reasons.push(`케이스 ${c.slug}를 판정하지 못했다: ${String(e).split("\n")[0]}`);
      return false;
    }
  };
  const baseSlugs = new Set(base.cases.map((c) => c.slug));
  const headSlugs = new Set(head.cases.map((c) => c.slug));
  const deleted = [...baseSlugs].filter((s) => !headSlugs.has(s));
  if (deleted.length > 0 && !plan.allowDeletion) {
    reasons.push(`이 PR은 평가 케이스를 삭제할 수 없다: ${deleted.join(", ")}`);
  }
  const newCases: EvalResult["newCases"] = [];
  const regressions: string[] = [];
  for (const c of head.cases) {
    if (baseSlugs.has(c.slug)) {
      if (!(await safeDetects(headRoot, c))) regressions.push(c.slug);
      continue;
    }
    // base 판정: head가 정의한 케이스(픽스처 포함)를 base 트리의 설정·프롬프트로 판정한다.
    const r = {
      slug: c.slug,
      base: await safeDetects(baseRoot, c),
      head: await safeDetects(headRoot, c),
    };
    newCases.push(r);
    if (r.base) {
      reasons.push(`새 케이스 ${c.slug}를 base도 이미 잡는다. 이 PR이 바꾼 것이 없다는 뜻이다.`);
    } else if (!r.head) {
      reasons.push(`새 케이스 ${c.slug}를 head도 잡지 못한다.`);
    }
  }
  if (regressions.length > 0) {
    reasons.push(`기존 케이스를 더 이상 잡지 못한다(회귀): ${regressions.join(", ")}`);
  }
  if (plan.requireNewCase && newCases.length === 0) {
    reasons.push("개선 PR인데 새 평가 케이스가 없다.");
  }
  return {
    pr: plan.pr,
    ok: reasons.length === 0,
    reasons,
    newCases,
    regressions,
    deleted,
    loadErrors,
  };
}

interface EslintLike {
  lintText(
    text: string,
    o: { filePath: string },
  ): Promise<{ messages: { severity: number; ruleId: string | null }[] }[]>;
}

// 이 함수는 PR 코드(head의 eslint.config.js)를 실행한다. 토큰이 없는 eval-run job에서만 부른다.
export function eslintDetector(): Detector {
  return {
    async lint(treeRoot, text, asPath) {
      const req = createRequire(path.join(treeRoot, "package.json"));
      const { ESLint } = req("eslint") as { ESLint: new (o: { cwd: string }) => EslintLike };
      const eslint = new ESLint({ cwd: treeRoot });
      const results = await eslint.lintText(text, { filePath: path.join(treeRoot, asPath) });
      // 무시 대상 파일은 severity 1 경고만 나오므로 빈 목록이 된다.
      return results.flatMap((r) =>
        r.messages.filter((m) => m.severity === 2 && m.ruleId).map((m) => m.ruleId as string),
      );
    },
  };
}

export const EVAL_STEP_TIMEOUT_MS = 10 * 60_000;

// head 트리의 의존성 설치는 PR 코드를 실행할 수 있다. 시크릿·GitHub 토큰이 없는 job에서만 부른다.
export async function runEval(
  deps: StageDeps,
  plan: EvalPlan,
  baseRoot: string,
): Promise<EvalResult> {
  const headRoot = deps.settings.workdir;
  const fail = (reason: string): EvalResult => ({
    pr: plan.pr,
    ok: false,
    reasons: [reason],
    newCases: [],
    regressions: [],
    deleted: [],
    loadErrors: [],
  });
  const env = scrubEnv(deps.settings.env);
  const exec = async (cmd: string, args: string[]) => {
    try {
      return await deps.spawn(cmd, args, {
        cwd: headRoot,
        env,
        signal: AbortSignal.timeout(EVAL_STEP_TIMEOUT_MS),
      });
    } catch (e) {
      return { code: null, stdout: "", stderr: String(e) };
    }
  };
  const head = await exec("git", ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (head.code !== 0 || head.stdout.trim() !== plan.headSha) {
    return fail(
      `작업 트리 head(${head.stdout.trim() || "알 수 없음"})가 판정 대상 ${plan.headSha}와 다르다.`,
    );
  }
  const install = await exec("pnpm", ["install", "--frozen-lockfile"]);
  if (install.code !== 0) return fail("head 트리의 의존성 설치가 실패했다.");
  return judgeEval(plan, baseRoot, headRoot, eslintDetector());
}

export function renderEvalText(r: EvalResult): string {
  const label = (b: boolean) => (b ? "잡음" : "못 잡음");
  return [
    `eval ${r.ok ? "통과" : "실패"}(PR #${r.pr})`,
    ...r.reasons,
    ...r.newCases.map((c) => `- ${c.slug}: base=${label(c.base)}, head=${label(c.head)}`),
  ].join("\n");
}

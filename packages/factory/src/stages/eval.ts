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
  // base는 새 케이스를 base 규칙으로 판정했을 때의 결과다. 개선 PR이 아니면 판정하지 않으므로 null이다.
  newCases: { slug: string; base: boolean | null; head: boolean }[];
  regressions: string[];
  deleted: string[];
  loadErrors: string[];
}

function sameCase(a: LoadedCase, b: LoadedCase): boolean {
  return JSON.stringify(a.spec) === JSON.stringify(b.spec) && a.fixtureText === b.fixtureText;
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
  const baseBySlug = new Map(base.cases.map((c) => [c.slug, c]));
  const headSlugs = new Set(head.cases.map((c) => c.slug));
  const deleted = [...baseBySlug.keys()].filter((s) => !headSlugs.has(s));
  if (deleted.length > 0 && !plan.allowDeletion) {
    reasons.push(`이 PR은 평가 케이스를 삭제할 수 없다: ${deleted.join(", ")}`);
  }
  const newOnes = head.cases.filter((c) => !baseBySlug.has(c.slug));
  const existing = head.cases.filter((c) => baseBySlug.has(c.slug));

  // base 쪽 판정을 모두 끝낸 뒤에 head 쪽 판정을 시작한다. head 코드(ESLint 설정)가 base 판정에
  // 영향을 주지 못하게 하기 위한 순서다. 개선 PR만 새 케이스를 base 규칙으로 판정한다.
  const baseResult = new Map<string, boolean>();
  if (plan.requireNewCase) {
    for (const c of newOnes) baseResult.set(c.slug, await safeDetects(baseRoot, c));
  }

  const newCases: EvalResult["newCases"] = [];
  const regressions: string[] = [];
  for (const c of existing) {
    const orig = baseBySlug.get(c.slug)!;
    let ok = await safeDetects(headRoot, c);
    if (!plan.allowDeletion) {
      // 봇 PR은 기존 케이스를 바꿀 수 없고, base 정의 그대로 head에서 계속 잡혀야 한다.
      if (!sameCase(orig, c)) {
        reasons.push(`기존 평가 케이스 ${c.slug}를 봇 PR이 바꿨다.`);
      }
      if (!(await safeDetects(headRoot, orig))) ok = false;
    }
    if (!ok) regressions.push(c.slug);
  }
  for (const c of newOnes) {
    const r = {
      slug: c.slug,
      base: plan.requireNewCase ? (baseResult.get(c.slug) ?? false) : null,
      head: await safeDetects(headRoot, c),
    };
    newCases.push(r);
    if (r.base === true) {
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

const ESLINT_TIMEOUT_MS = 2 * 60_000;

// ESLint를 트리 루트에서 자식 프로세스로 실행한다. PR 코드(head의 eslint.config.js)가 이 프로세스를
// 종료시키거나 공유 상태를 바꾸지 못하게 한다. 토큰이 없는 eval-run job에서만 부른다.
export function eslintDetector(deps: Pick<StageDeps, "spawn" | "settings">): Detector {
  return {
    async lint(treeRoot, text, asPath) {
      const res = await deps.spawn(
        "pnpm",
        [
          "exec",
          "eslint",
          "--stdin",
          "--stdin-filename",
          asPath,
          "-f",
          "json",
          "--no-warn-ignored",
        ],
        {
          cwd: treeRoot,
          env: scrubEnv(deps.settings.env),
          input: text,
          signal: AbortSignal.timeout(ESLINT_TIMEOUT_MS),
        },
      );
      // 종료 코드 0은 위반 없음, 1은 위반 있음이다. 그 밖의 코드나 JSON이 아닌 출력은 판정 불가다.
      if (res.code !== 0 && res.code !== 1) {
        throw new Error(
          `ESLint가 종료 코드 ${res.code}로 끝났다: ${res.stderr.trim().split("\n")[0] ?? ""}`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.stdout);
      } catch {
        throw new Error("ESLint 출력을 JSON으로 읽지 못했다");
      }
      if (!Array.isArray(parsed)) throw new Error("ESLint 출력 형식이 배열이 아니다");
      // 무시 대상 파일은 결과가 비므로 빈 목록이 된다.
      return (parsed as { messages?: { severity: number; ruleId: string | null }[] }[]).flatMap(
        (r) =>
          (r.messages ?? [])
            .filter((m) => m.severity === 2 && m.ruleId)
            .map((m) => m.ruleId as string),
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
  const spawnIn = async (cwd: string, cmd: string, args: string[]) => {
    try {
      return await deps.spawn(cmd, args, {
        cwd,
        env,
        signal: AbortSignal.timeout(EVAL_STEP_TIMEOUT_MS),
      });
    } catch (e) {
      return { code: null, stdout: "", stderr: String(e) };
    }
  };
  const exec = (cmd: string, args: string[]) => spawnIn(headRoot, cmd, args);
  const head = await exec("git", ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (head.code !== 0 || head.stdout.trim() !== plan.headSha) {
    return fail(
      `작업 트리 head(${head.stdout.trim() || "알 수 없음"})가 판정 대상 ${plan.headSha}와 다르다.`,
    );
  }
  const baseHead = await spawnIn(baseRoot, "git", ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (baseHead.code !== 0 || baseHead.stdout.trim() !== plan.baseSha) {
    return fail(
      `base 작업 트리(${baseHead.stdout.trim() || "알 수 없음"})가 판정 대상 ${plan.baseSha}와 다르다.`,
    );
  }
  const install = await exec("pnpm", ["install", "--frozen-lockfile"]);
  if (install.code !== 0) return fail("head 트리의 의존성 설치가 실패했다.");
  return judgeEval(plan, baseRoot, headRoot, eslintDetector(deps));
}

export function renderEvalText(r: EvalResult): string {
  const label = (b: boolean | null) => (b === null ? "판정 안 함" : b ? "잡음" : "못 잡음");
  return [
    `eval ${r.ok ? "통과" : "실패"}(PR #${r.pr})`,
    ...r.reasons,
    ...r.newCases.map((c) => `- ${c.slug}: base=${label(c.base)}, head=${label(c.head)}`),
  ].join("\n");
}

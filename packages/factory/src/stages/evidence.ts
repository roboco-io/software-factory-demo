import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { scrubEnv } from "../agents/env";
import { tail } from "../exec/checks";
import type { ProcessResult } from "../exec/process";
import { TooManyFilesError, type ChangedFile } from "../github/port";
import { isSafeRelativePath, isTestFile, planSuites } from "../policy/evidence";
import { parsePrMeta } from "../report/pr";
import type { StageDeps } from "./deps";

// 40자 소문자 16진수 커밋 SHA. CLI 옵션 검사(cli.ts의 sha40)도 이 함수를 쓴다.
const SHA = /^[0-9a-f]{40}$/;
export function isSha40(s: string): boolean {
  return SHA.test(s);
}

// evidence-plan job이 만들고 evidence job이 job output으로 받는 계획. 받는 쪽은 이 스키마로 다시 검증한다.
export const EvidencePlanSchema = z.object({
  pr: z.number().int().positive(),
  required: z.boolean(),
  reason: z.string().max(500),
  reasonCode: z.enum(["not_bug", "evaluated", "no_test_files", "unknown_state"]),
  baseSha: z.string().regex(SHA),
  headSha: z.string().regex(SHA),
  testFiles: z.array(z.string().refine(isTestFile, "테스트 파일 경로가 아니다")).max(200),
});
export type EvidencePlan = z.infer<typeof EvidencePlanSchema>;

export async function runEvidencePlan(
  deps: StageDeps,
  args: { pr: number; baseSha: string; headSha: string },
): Promise<EvidencePlan> {
  const plan = (
    required: boolean,
    reasonCode: EvidencePlan["reasonCode"],
    reason: string,
    testFiles: string[] = [],
  ): EvidencePlan =>
    EvidencePlanSchema.parse({
      pr: args.pr,
      required,
      reason,
      reasonCode,
      baseSha: args.baseSha,
      headSha: args.headSha,
      testFiles,
    });
  const pull = await deps.gh.getPull(args.pr);
  // 팩토리 봇이 연 PR만 대상이다. 사람이 연 PR의 본문 표식은 신뢰하지 않는다(stages/risk.ts와 같은 기준).
  const meta = pull.author === deps.settings.botLogin ? parsePrMeta(pull.body) : null;
  if (!meta) {
    return plan(
      false,
      "not_bug",
      "봇이 연 팩토리 PR이 아니다(표식 없음, 사람이 연 PR 등). 버그 PR 증거 검사를 하지 않는다.",
    );
  }
  const issue = await deps.gh.getIssue(meta.issue);
  if (!issue.labels.includes("type:bug")) {
    return plan(
      false,
      "not_bug",
      `연결 이슈 #${meta.issue}에 type:bug 라벨이 없다. 버그 PR 증거 검사를 하지 않는다.`,
    );
  }
  // 이벤트 이후 head가 바뀌었으면 이 head의 파일 목록을 알 수 없다. 실패로 두고 새 head의 실행에 맡긴다.
  if (pull.headSha !== args.headSha) {
    return plan(
      true,
      "unknown_state",
      `PR head가 ${pull.headSha}로 바뀌어 ${args.headSha}의 테스트 파일을 확정할 수 없다. 새 head의 evidence 실행이 판정한다.`,
    );
  }
  let files: ChangedFile[];
  try {
    files = await deps.gh.listPullFiles(args.pr);
  } catch (e) {
    if (!(e instanceof TooManyFilesError)) throw e;
    return plan(true, "unknown_state", "변경 파일이 너무 많아 테스트 파일 목록을 확정할 수 없다.");
  }
  // listPullFiles가 끝난 뒤 head가 다시 바뀌었는지 확인한다. 바뀌었으면 받은 목록은 다른 커밋의 것이다.
  const after = await deps.gh.getPull(args.pr);
  if (after.headSha !== args.headSha) {
    return plan(
      true,
      "unknown_state",
      `파일 목록을 읽는 동안 PR head가 ${after.headSha}로 바뀌었다. 새 head의 evidence 실행이 판정한다.`,
    );
  }
  // 원본 파일명에 그대로 검사한다. 역슬래시를 슬래시로 바꾸면 위험한 이름이 안전한 경로로 둔갑한다.
  const testFiles = [
    ...new Set(files.filter((f) => !f.removed && isTestFile(f.filename)).map((f) => f.filename)),
  ].sort();
  if (testFiles.length > 200) {
    return plan(true, "unknown_state", "테스트 파일이 200개를 넘어 확정할 수 없다.");
  }
  return plan(
    true,
    testFiles.length === 0 ? "no_test_files" : "evaluated",
    `연결 이슈 #${meta.issue}가 type:bug다. PR이 추가·수정한 테스트 파일 ${testFiles.length}개로 판정한다.`,
    testFiles,
  );
}

export const EVIDENCE_STEP_TIMEOUT_MS = 15 * 60_000;

export interface SuiteOutcome {
  suite: string;
  targets: string[];
  baseCode: number | null;
  headCode: number | null;
  baseOutput: string;
  headOutput: string;
}

export interface EvidenceResult {
  pr: number;
  required: boolean;
  ok: boolean;
  reason: string;
  reasonCode: EvidencePlan["reasonCode"];
  testFiles: string[];
  unsupported: string[];
  suites: SuiteOutcome[];
}

// 이 함수는 PR 코드(테스트와 그 의존성)를 실행한다. 시크릿·GitHub 토큰이 없는 evidence job에서만 부른다(spec 7.1.2).
export async function runEvidence(deps: StageDeps, plan: EvidencePlan): Promise<EvidenceResult> {
  const { runs, unsupported } = planSuites(plan.testFiles);
  const done = (ok: boolean, reason: string, suites: SuiteOutcome[] = []): EvidenceResult => ({
    pr: plan.pr,
    required: plan.required,
    ok,
    reason,
    reasonCode: plan.reasonCode,
    testFiles: plan.testFiles,
    unsupported,
    suites,
  });
  if (!plan.required) return done(true, plan.reason);
  // 판정 T2-a: reasonCode와 관계없이(unknown_state 포함) 테스트 파일이 없으면 실패다.
  if (plan.testFiles.length === 0) {
    return done(
      false,
      `버그 PR인데 테스트 파일 변경이 없다. 수정 전 코드에서 실패하는 재현 테스트를 추가해야 한다. (${plan.reason})`,
    );
  }
  // 호출자가 스키마를 거치지 않았어도 경로를 다시 검사한다. 무엇이든 실행하기 전에 거부한다.
  // isTestFile은 isSafeRelativePath(`..`, 절대 경로, `-`로 시작하는 세그먼트 거부)를 포함한다.
  const bad = plan.testFiles.find((f) => !isTestFile(f));
  if (bad !== undefined) return done(false, `안전하지 않은 테스트 파일 경로: ${bad}`);
  if (runs.length === 0) {
    return done(
      false,
      "실행할 수 있는 Vitest 테스트 파일(apps/api, apps/web, packages/factory 아래 *.test.ts(x))이 없다. Playwright E2E(apps/web/e2e)는 덮어쓰기만 하고 실행하지 않으므로 E2E만으로는 evidence를 통과하지 못한다. Vitest 재현 테스트를 추가해야 한다.",
    );
  }
  // vitest에 넘기는 인자가 옵션으로 해석되지 않게 한다(판정 F8). isSafeRelativePath가 이미 막지만 실행 직전에 다시 확인한다.
  const flagLike = runs.flatMap((r) => r.targets).find((t) => t.startsWith("-"));
  if (flagLike !== undefined) return done(false, `안전하지 않은 테스트 파일 경로: ${flagLike}`);
  const env = scrubEnv(deps.settings.env);
  const repo = deps.settings.workdir;
  const exec = async (cmd: string, args: string[], cwd: string): Promise<ProcessResult> => {
    try {
      return await deps.spawn(cmd, args, {
        cwd,
        env,
        signal: AbortSignal.timeout(EVIDENCE_STEP_TIMEOUT_MS),
      });
    } catch (e) {
      return { code: null, stdout: "", stderr: String(e) };
    }
  };
  const head = await exec("git", ["rev-parse", "--verify", "HEAD^{commit}"], repo);
  if (head.code !== 0 || head.stdout.trim() !== plan.headSha) {
    return done(
      false,
      `작업 트리 head(${head.stdout.trim() || "알 수 없음"})가 판정 대상 ${plan.headSha}와 다르다.`,
    );
  }
  const root = mkdtempSync(path.join(deps.settings.env.RUNNER_TEMP || tmpdir(), "evidence-"));
  const overlay = path.join(root, "overlay");
  try {
    const add = await exec(
      "git",
      ["worktree", "add", "--detach", "--", overlay, plan.baseSha],
      repo,
    );
    if (add.code !== 0)
      return done(false, `base 커밋 ${plan.baseSha}로 작업 트리를 만들지 못했다.`);
    for (const file of plan.testFiles) {
      const target = path.resolve(overlay, file);
      if (!isSafeRelativePath(file) || !target.startsWith(`${overlay}${path.sep}`)) {
        return done(false, `안전하지 않은 테스트 파일 경로: ${file}`);
      }
      const blob = await exec("git", ["show", `${plan.headSha}:${file}`], repo);
      if (blob.code !== 0 || blob.truncated) return done(false, `head에서 ${file}을 읽지 못했다.`);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, blob.stdout);
    }
    for (const [dir, name] of [
      [overlay, "base+테스트"],
      [repo, "head"],
    ] as const) {
      const install = await exec("pnpm", ["install", "--frozen-lockfile"], dir);
      if (install.code !== 0) return done(false, `${name} 트리의 의존성 설치가 실패했다.`);
    }
    const suites: SuiteOutcome[] = [];
    for (const run of runs) {
      const args = ["--filter", run.filter, "exec", "vitest", "run", ...run.targets];
      const base = await exec("pnpm", args, overlay);
      const after = await exec("pnpm", args, repo);
      suites.push({
        suite: run.suite,
        targets: run.targets,
        baseCode: base.code,
        headCode: after.code,
        baseOutput: tail(`${base.stdout}\n${base.stderr}`.trim(), 3000),
        headOutput: tail(`${after.stdout}\n${after.stderr}`.trim(), 3000),
      });
    }
    if (suites.some((s) => s.baseCode === null || s.headCode === null)) {
      return done(false, "테스트 실행이 시간 제한(15분)에 걸리거나 강제 종료되었다.", suites);
    }
    if (!suites.every((s) => s.headCode === 0)) {
      return done(false, "재현 테스트가 수정 후(head) 코드에서 실패했다.", suites);
    }
    if (!suites.some((s) => s.baseCode !== 0)) {
      return done(
        false,
        "재현 테스트가 수정 전(base) 코드에서도 통과했다. 버그를 재현하지 못하는 테스트다.",
        suites,
      );
    }
    return done(
      true,
      "재현 테스트가 수정 전(base) 코드에서 실패하고 수정 후(head) 코드에서 통과했다.",
      suites,
    );
  } finally {
    await exec("git", ["worktree", "remove", "--force", "--", overlay], repo);
    rmSync(root, { recursive: true, force: true });
  }
}

export function renderEvidenceText(r: EvidenceResult): string {
  const lines = [
    `evidence ${r.ok ? "통과" : "실패"}(PR #${r.pr}, reasonCode=${r.reasonCode}): ${r.reason}`,
    `테스트 파일: ${r.testFiles.length > 0 ? r.testFiles.join(", ") : "(없음)"}`,
  ];
  if (r.unsupported.length > 0) lines.push(`실행하지 않은 테스트: ${r.unsupported.join(", ")}`);
  for (const s of r.suites) {
    lines.push(
      `- ${s.suite} ${s.targets.join(" ")}: base 종료 코드 ${s.baseCode}, head 종료 코드 ${s.headCode}`,
    );
    if (!r.ok) lines.push(`  base 출력:\n${s.baseOutput}`, `  head 출력:\n${s.headOutput}`);
  }
  return lines.join("\n");
}

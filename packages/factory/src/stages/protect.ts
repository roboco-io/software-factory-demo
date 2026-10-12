import type { TimedResult } from "../agents/budget";
import type { Budget, FailureReason } from "../agents/types";
import { codeCell } from "../report/text";
import type { StageDeps } from "./deps";
import { inspectChanges, type ChangeInspection } from "./worktree";

// agent VM이 쓴 실행 결과의 ok·턴·시간·비용은 신뢰할 수 없다. ok는 publish가 검증한 값으로 정하고,
// 턴·시간·비용은 역할 예산으로 자른다. 실패 사유는 ok=false일 때만 남긴다.
export function clampResult(
  reported: TimedResult,
  budget: Budget,
  ok: boolean,
  failureReason?: FailureReason,
): TimedResult {
  const { failureReason: _reported, costUsd, ...rest } = reported;
  void _reported;
  const result: TimedResult = {
    ...rest,
    ok,
    turns: Math.min(reported.turns, budget.maxTurns),
    durationMs: Math.min(reported.durationMs, budget.timeoutMs),
  };
  if (costUsd !== undefined) {
    result.costUsd = budget.maxUsd === undefined ? costUsd : Math.min(costUsd, budget.maxUsd);
  }
  if (!ok) result.failureReason = failureReason ?? reported.failureReason ?? "engine_error";
  return result;
}

const MAX_LISTED_FILES = 20;

export function fileList(files: string[]): string {
  const shown = files.slice(0, MAX_LISTED_FILES).map((f) => `\`${codeCell(f)}\``);
  const rest = files.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} 외 ${rest}개` : shown.join(", ");
}

export type BundleCheck = { ok: true; verified: ChangeInspection } | { ok: false; reason: string };

// publish 단계가 쓰기 전에 하는 번들 재검증. 결과 파일은 에이전트가 고칠 수 있으므로
// 저장소 상태(번들)에서 head SHA, 기준 커밋과의 조상 관계, 변경 파일과 위험 등급을 다시 구한다.
// allowed가 있으면 T3 검사 대신 모든 변경 파일이 allowed를 만족하는지로 판정한다(improve 역할).
export async function importAndVerify(
  deps: StageDeps,
  target: { branch: string; baseSha: string; sha: string; allowed?: (file: string) => boolean },
): Promise<BundleCheck> {
  await deps.git.fetch("main");
  if (deps.settings.bundlePath) {
    await deps.git.importBundle(deps.settings.bundlePath, target.branch);
  }
  const head = await deps.git.headSha();
  if (head !== target.sha) {
    return {
      ok: false,
      reason:
        "publish 단계의 재검증에서 변경이 거부되었다(결과 파일의 커밋 SHA가 번들의 head와 다르다).",
    };
  }
  if (!(await deps.git.isAncestor(target.baseSha))) {
    return {
      ok: false,
      reason: `publish 단계의 재검증에서 변경이 거부되었다(번들 head가 준비 시점 main 커밋 ${target.baseSha.slice(0, 12)}의 후손이 아니다).`,
    };
  }
  const verified = await inspectChanges(deps, "origin/main");
  if (target.allowed) {
    const outside = verified.files.filter((f) => !target.allowed!(f));
    if (outside.length > 0 || verified.files.length === 0) {
      return {
        ok: false,
        reason: `publish 단계의 재검증에서 변경이 거부되었다(허용 경로 밖 파일: ${fileList(outside) || "없음"}, 변경 파일 수: ${verified.files.length}).`,
      };
    }
    return { ok: true, verified };
  }
  if (verified.forbidden.length > 0 || verified.files.length === 0) {
    return {
      ok: false,
      reason: `publish 단계의 재검증에서 변경이 거부되었다(T3 파일: ${fileList(verified.forbidden) || "없음"}, 변경 파일 수: ${verified.files.length}).`,
    };
  }
  return { ok: true, verified };
}

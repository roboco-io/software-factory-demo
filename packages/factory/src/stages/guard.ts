import type { RunRecord } from "../runs/store";
import { stateLabel } from "../state/machine";
import { reconcileBoard } from "./board";
import { branchFor, runLink, usedToday, utcDay } from "./common";
import type { StageDeps } from "./deps";

export const BREAKER = { windowDays: 7, minRuns: 10, minSuccessRate: 0.5 } as const;
const DAY_MS = 86_400_000;

export interface BreakerState {
  total: number;
  succeeded: number;
  successRate: number | null;
  tripped: boolean;
}

export interface GuardResult {
  breaker: BreakerState;
  paused: boolean;
  resumed: number[];
  board: number;
}

export function evaluateBreaker(runs: RunRecord[], now: Date, since?: Date): BreakerState {
  const from = Math.max(now.getTime() - BREAKER.windowDays * DAY_MS, since?.getTime() ?? 0);
  const relevant = runs.filter(
    (r) => (r.role === "implement" || r.role === "fix") && Date.parse(r.ts) >= from,
  );
  const succeeded = relevant.filter((r) => r.ok).length;
  const successRate = relevant.length > 0 ? succeeded / relevant.length : null;
  return {
    total: relevant.length,
    succeeded,
    successRate,
    tripped:
      relevant.length >= BREAKER.minRuns &&
      successRate !== null &&
      successRate < BREAKER.minSuccessRate,
  };
}

export async function runGuard(deps: StageDeps): Promise<GuardResult> {
  const now = deps.now();
  let from = now.getTime() - BREAKER.windowDays * DAY_MS;
  // 사람이 알림 이슈를 보고 재개한 뒤에는 그 이전 실패를 다시 세지 않는다.
  const lastAlert = await deps.gh.latestIssueWithLabel("factory:alert");
  if (lastAlert) from = Math.max(from, Date.parse(lastAlert.createdAt) || 0);
  const runs = await deps.runs.since(new Date(now.getTime() - BREAKER.windowDays * DAY_MS));
  const breaker = evaluateBreaker(runs, now, new Date(from));
  let paused = deps.settings.paused;
  if (breaker.tripped && !paused) {
    await deps.gh.setVariable("FACTORY_PAUSED", "true");
    // 열려 있는 알림이 있으면 새로 만들지 않고 댓글로 갱신한다.
    if (lastAlert?.state === "open") {
      await deps.gh.comment(
        lastAlert.number,
        `차단기가 다시 작동했다(성공률 ${Math.round((breaker.successRate ?? 0) * 100)}%, ${breaker.total}회 중 ${breaker.succeeded}회 성공).${runLink(deps.settings)}`,
      );
      return { breaker, paused: true, resumed: [], board: await reconcileBoard(deps) };
    }
    const pct = Math.round((breaker.successRate ?? 0) * 100);
    await deps.gh.createIssue(
      "팩토리 실패율 차단기 작동",
      `최근 ${BREAKER.windowDays}일 implement·fix 런 ${breaker.total}회 중 ${breaker.succeeded}회가 성공했다(성공률 ${pct}%). 기준(${BREAKER.minRuns}회 이상, 성공률 ${BREAKER.minSuccessRate * 100}% 미만)에 걸려 리포 변수 FACTORY_PAUSED를 true로 바꿨다.\n\n- 멈춘 것: implement·fix 단계 시작\n- 계속 동작하는 것: triage, 리뷰 결과 기록, 병합 판단, 배포 결과 반영\n- 재개 방법: 실패 원인을 확인한 뒤 사람이 리포 변수 FACTORY_PAUSED를 false로 바꾼다.\n${runLink(deps.settings)}`,
      ["factory:alert"],
    );
    paused = true;
  }
  const resumed: number[] = [];
  if (!paused) {
    let used = await usedToday(deps, runs, utcDay(now));
    const approved = (await deps.gh.listOpenIssues())
      .filter((i) => i.labels.includes(stateLabel("approved")))
      .sort((a, b) => a.number - b.number);
    for (const issue of approved) {
      if (used >= deps.settings.dailyLimit) break;
      if (await deps.gh.findOpenPullByHead(branchFor(issue.number))) continue;
      await deps.gh.dispatchWorkflow("factory-implement.yml", { issue: String(issue.number) });
      resumed.push(issue.number);
      used++;
    }
  }
  return { breaker, paused, resumed, board: await reconcileBoard(deps) };
}

import type { RunRecord } from "../runs/store";
import { stateLabel } from "../state/machine";
import { agentRunsOn, branchFor, runLink, utcDay } from "./common";
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
}

export function evaluateBreaker(runs: RunRecord[], now: Date): BreakerState {
  const from = now.getTime() - BREAKER.windowDays * DAY_MS;
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
  const runs = await deps.runs.since(new Date(now.getTime() - BREAKER.windowDays * DAY_MS));
  const breaker = evaluateBreaker(runs, now);
  let paused = deps.settings.paused;
  if (breaker.tripped && !paused) {
    await deps.gh.setVariable("FACTORY_PAUSED", "true");
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
    let used = agentRunsOn(runs, utcDay(now));
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
  return { breaker, paused, resumed };
}

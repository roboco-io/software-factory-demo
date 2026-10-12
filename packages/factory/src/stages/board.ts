import { STATES, stateFromLabels, stateLabel, type State } from "../state/machine";
import type { BoardSpec } from "../github/port";
import type { StageDeps } from "./deps";

export const BOARD: BoardSpec = { title: "Software Factory", field: "Factory", options: STATES };

const RECONCILE_LIMIT = 30;

// 보드는 표시용이다. 어떤 실패도 상태 전이를 막지 않는다.
export async function syncBoard(deps: StageDeps, issue: number, state: State): Promise<void> {
  try {
    const r = await deps.gh.syncBoardStatus(BOARD, issue, state);
    if (r !== "synced") deps.log(`board: #${issue} 동기화 건너뜀(${r})`);
  } catch (e) {
    deps.log(`board: #${issue} 동기화 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// 상태 라벨이 있는 열린 이슈(PR 제외)를 보드에 맞춘다. 동기화한 건수를 돌려준다.
export async function reconcileBoard(
  deps: StageDeps,
  limit: number = RECONCILE_LIMIT,
): Promise<number> {
  let count = 0;
  let attempts = 0;
  try {
    const issues = (await deps.gh.listOpenIssues())
      .filter((i) => !i.isPullRequest)
      .sort((a, b) => a.number - b.number);
    for (const issue of issues) {
      if (attempts >= limit) break;
      if (!STATES.some((s) => issue.labels.includes(stateLabel(s)))) continue;
      attempts++;
      try {
        const { state } = stateFromLabels(issue.labels);
        const r = await deps.gh.syncBoardStatus(BOARD, issue.number, state);
        if (r !== "synced") {
          deps.log(`board: 재조정 중단(${r})`);
          break;
        }
        count++;
      } catch (e) {
        deps.log(
          `board: #${issue.number} 재조정 실패: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  } catch (e) {
    deps.log(`board: 재조정 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
  return count;
}

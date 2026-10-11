import { parseFactoryIssues } from "../report/commit";
import { moveTo, record, runLink, stepRecord } from "./common";
import type { StageDeps } from "./deps";

export async function runDeployed(deps: StageDeps, { sha }: { sha: string }): Promise<number[]> {
  const done: number[] = [];
  for (const issue of parseFactoryIssues(await deps.gh.getCommitMessage(sha))) {
    const moved = await moveTo(
      deps,
      issue,
      "deployed",
      "deploy",
      `프로덕션 배포와 스모크 테스트가 통과했다(커밋 \`${sha.slice(0, 7)}\`). 이슈를 닫는다.${runLink(deps.settings)}`,
    );
    if (!moved) continue;
    await deps.gh.closeIssue(issue);
    await record(deps, stepRecord("deploy", issue, null, true));
    done.push(issue);
  }
  return done;
}

export async function runDeployFailed(
  deps: StageDeps,
  { sha }: { sha: string },
): Promise<number[]> {
  const done: number[] = [];
  for (const issue of parseFactoryIssues(await deps.gh.getCommitMessage(sha))) {
    const moved = await moveTo(
      deps,
      issue,
      "needs-human",
      "deploy",
      `프로덕션 배포 또는 스모크 테스트가 실패했다(커밋 \`${sha.slice(0, 7)}\`). 프로덕션 API가 이전 버전으로 남았을 수 있다. 롤백 절차는 README의 "배포 롤백" 절을 따른다.${runLink(deps.settings)}`,
    );
    if (!moved) continue;
    await deps.gh.addLabels(issue, ["source:deploy"]);
    await record(deps, stepRecord("deploy", issue, null, false, "deploy_failed"));
    done.push(issue);
  }
  return done;
}

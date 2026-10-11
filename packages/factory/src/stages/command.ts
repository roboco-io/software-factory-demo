import { canTransition } from "../state/machine";
import { isBot, isWriter, moveTo, readState, record, runLink, stepRecord } from "./common";
import type { StageDeps } from "./deps";

export type FactoryCommand = "go" | "stop" | "retry";

export interface CommandArgs {
  issue: number;
  actor: string;
  body: string;
}

export type CommandOutcome =
  "ignored" | "pull-request" | "rejected" | "approved" | "redispatched" | "stopped" | "refused";

export function parseCommand(body: string): FactoryCommand | null {
  // 펜스 코드 블록(``` 또는 ~~~) 안의 줄은 명령으로 보지 않는다.
  let fence: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f?.[1]) {
      const mark = f[1][0] ?? "`";
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const m = /^ {0,3}@factory[ \t]+(go|stop|retry)\b(?![-\w])/i.exec(line);
    if (m?.[1]) return m[1].toLowerCase() as FactoryCommand;
  }
  return null;
}

export async function runCommand(deps: StageDeps, args: CommandArgs): Promise<CommandOutcome> {
  if (isBot(deps.settings, args.actor) || args.actor.endsWith("[bot]")) return "ignored";
  const cmd = parseCommand(args.body);
  if (!cmd) return "ignored";
  const issue = await deps.gh.getIssue(args.issue);
  if (issue.isPullRequest) {
    await deps.gh.comment(
      args.issue,
      "`@factory` 명령은 PR이 아니라 연결된 이슈에 남긴다. PR 본문의 `Refs #N`이 그 이슈다.",
    );
    return "pull-request";
  }
  if (!(await isWriter(deps.gh, args.actor))) {
    await deps.gh.comment(
      args.issue,
      `@${args.actor} 님의 \`@factory ${cmd}\` 명령을 거부했다. 이 명령은 리포 권한 write 이상(admin, maintain, write)인 사용자만 실행할 수 있다.`,
    );
    await record(deps, stepRecord("command", args.issue, null, false, "permission_denied"));
    return "rejected";
  }
  const { state } = await readState(deps.gh, args.issue);
  if (cmd === "stop") {
    if (!canTransition(state, "needs-human", "command")) {
      await deps.gh.comment(
        args.issue,
        `현재 상태 \`factory:${state}\`에서는 중지할 자동화 작업이 없다.`,
      );
      return "refused";
    }
    const cancelled = await deps.gh.cancelRunsForIssue(args.issue);
    await moveTo(
      deps,
      args.issue,
      "needs-human",
      "command",
      `@${args.actor}의 \`@factory stop\`으로 자동화를 멈췄다. 진행 중이던 워크플로 run ${cancelled}개를 취소했다. 다시 시작하려면 \`@factory go\`를 남긴다.${runLink(deps.settings)}`,
    );
    await record(deps, stepRecord("command", args.issue, null, true));
    return "stopped";
  }
  if (state === "approved") {
    await deps.gh.dispatchWorkflow("factory-implement.yml", { issue: String(args.issue) });
    await deps.gh.comment(args.issue, "이미 승인된 이슈다. 구현 워크플로를 다시 시작했다.");
    await record(deps, stepRecord("command", args.issue, null, true));
    return "redispatched";
  }
  if (!(await moveTo(deps, args.issue, "approved", "command"))) {
    await deps.gh.comment(
      args.issue,
      `현재 상태 \`factory:${state}\`에서는 \`@factory ${cmd}\`를 실행할 수 없다. 진행 중인 작업을 멈추려면 \`@factory stop\`을 먼저 남긴다.`,
    );
    return "refused";
  }
  await record(deps, stepRecord("command", args.issue, null, true));
  return "approved";
}

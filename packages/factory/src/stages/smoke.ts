import { z } from "zod";
import type { Comment, Issue } from "../github/port";
import { codeCell, readMarker, writeMarker } from "../report/text";
import { isBot, record, runLink, stepRecord } from "./common";
import type { Settings, StageDeps } from "./deps";
import { findIntakeIssue, intakeMarker } from "./intake";

export const SMOKE_MARKER = "factory:smoke";
export const SMOKE_KEY = "production";
const SmokeStatusSchema = z.object({ status: z.enum(["failing", "recovered"]) });
export type SmokeStatus = z.infer<typeof SmokeStatusSchema>["status"];
export type SmokeAction = "created" | "commented" | "recovered" | "none";

const CHECKS =
  "프로덕션 읽기 전용 스모크(Hurl: `/api/health`, 글 목록, 태그 목록 / Playwright: 홈 화면 렌더링)";

// 워크플로의 checks job 결과(success|failure|cancelled|skipped|timed_out)를 받는다.
// success가 아닌 값은 모두 실패로 본다(건너뛰거나 취소된 검사를 통과로 취급하지 않는다). 값이 없으면 null.
export function normalizeSmokeResult(raw: string | undefined): "success" | "failure" | null {
  const v = raw?.trim();
  if (!v) return null;
  return v === "success" ? "success" : "failure";
}

// 이슈 본문과 봇 코멘트의 표식 중 마지막 값이 현재 상태다. 사람이 쓴 코멘트의 표식은 무시한다.
export function smokeStatus(issue: Issue, comments: Comment[], settings: Settings): SmokeStatus {
  let status: SmokeStatus =
    readMarker(issue.body, SMOKE_MARKER, SmokeStatusSchema)?.status ?? "failing";
  for (const c of comments) {
    if (!isBot(settings, c.author)) continue;
    const m = readMarker(c.body, SMOKE_MARKER, SmokeStatusSchema);
    if (m) status = m.status;
  }
  return status;
}

// 마지막 복구 이후 이어진 실패 횟수(이슈를 연 실패 포함). 봇 코멘트의 표식만 센다.
function failureStreak(issue: Issue, comments: Comment[], settings: Settings): number {
  let n = 1;
  for (const c of comments) {
    if (!isBot(settings, c.author)) continue;
    const m = readMarker(c.body, SMOKE_MARKER, SmokeStatusSchema);
    if (m?.status === "failing") n += 1;
    else if (m?.status === "recovered") n = 0;
  }
  return n;
}

function target(settings: Settings): string {
  const injected = settings.env.SMOKE_API_BASE?.trim().slice(0, 200);
  return injected ? `검증용으로 지정한 API \`${codeCell(injected)}\`` : "프로덕션 API와 웹";
}

export async function runSmokeReport(
  deps: StageDeps,
  { result }: { result: "success" | "failure" },
): Promise<{ action: SmokeAction; issue: number | null }> {
  const issue = findIntakeIssue(await deps.gh.listOpenIssues(), deps.settings, "smoke", SMOKE_KEY);
  const run = runLink(deps.settings);
  if (result === "failure") {
    const failing = writeMarker(SMOKE_MARKER, { status: "failing" });
    if (issue) {
      const streak = failureStreak(issue, await deps.gh.listComments(issue.number), deps.settings);
      await deps.gh.comment(
        issue.number,
        `${CHECKS}가 실패했다(복구 없이 ${streak + 1}회째). 대상: ${target(deps.settings)}.${run}\n\n${failing}`,
      );
      await record(deps, stepRecord("smoke", issue.number, null, false, "smoke_failed"));
      return { action: "commented", issue: issue.number };
    }
    const body = [
      `${CHECKS}가 실패했다. 대상: ${target(deps.settings)}. 실패한 단계와 로그는 워크플로 run에서 확인한다.${run}`,
      "",
      '실패가 이어지면 이 이슈에 코멘트를 추가하고, 다음 스모크가 성공하면 "복구됨" 코멘트를 남긴다. 이슈 종료는 사람이 정한다. 구현은 리포 쓰기 권한자의 `@factory go`가 있어야 시작한다.',
      "",
      failing,
      intakeMarker("smoke", SMOKE_KEY),
    ].join("\n");
    const n = await deps.gh.createIssue("[스모크] 프로덕션 읽기 전용 스모크 실패", body, [
      "source:smoke",
    ]);
    await record(deps, stepRecord("smoke", n, null, false, "smoke_failed"));
    return { action: "created", issue: n };
  }
  if (!issue) return { action: "none", issue: null };
  if (smokeStatus(issue, await deps.gh.listComments(issue.number), deps.settings) !== "failing") {
    return { action: "none", issue: issue.number };
  }
  await deps.gh.comment(
    issue.number,
    `복구됨: ${CHECKS}가 다시 통과했다. 대상: ${target(deps.settings)}.${run} 원인 조사와 이슈 종료는 사람이 정한다.\n\n${writeMarker(SMOKE_MARKER, { status: "recovered" })}`,
  );
  await record(deps, stepRecord("smoke", issue.number, null, true));
  return { action: "recovered", issue: issue.number };
}

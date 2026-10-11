import { z } from "zod";
import { TooManyFilesError, type ChangedFile } from "../github/port";
import { isTestFile } from "../policy/evidence";
import { parsePrMeta } from "../report/pr";
import type { StageDeps } from "./deps";

const SHA = /^[0-9a-f]{40}$/;

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

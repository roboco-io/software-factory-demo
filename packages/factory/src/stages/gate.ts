import { TooManyFilesError, type ChangedFile, type CheckRun, type Pull } from "../github/port";
import { classifyFiles } from "../policy/risk";
import { latestVerdict } from "../report/comments";
import { signatureTrailers } from "../report/commit";
import { parsePrMeta } from "../report/pr";
import { moveTo, readState, record, runLink, stepRecord } from "./common";
import type { StageDeps } from "./deps";

export type CheckState = "pass" | "pending" | "fail";

export function checkState(run: CheckRun | undefined): CheckState {
  if (!run || run.status !== "completed") return "pending";
  if (run.conclusion === "success" || run.conclusion === "skipped" || run.conclusion === "neutral")
    return "pass";
  // ci.yml의 cancel-in-progress로 취소된 실행은 새 실행이 곧 결과를 낸다.
  if (run.conclusion === null || run.conclusion === "cancelled" || run.conclusion === "stale")
    return "pending";
  return "fail";
}

export function summarizeChecks(
  runs: CheckRun[],
  required: string[],
): { state: CheckState; failing: string[]; pending: string[] } {
  const failing: string[] = [];
  const pending: string[] = [];
  for (const name of required) {
    const s = checkState(runs.find((r) => r.name === name));
    if (s === "fail") failing.push(name);
    else if (s === "pending") pending.push(name);
  }
  return {
    state: failing.length > 0 ? "fail" : pending.length > 0 ? "pending" : "pass",
    failing,
    pending,
  };
}

export function flattenFiles(files: ChangedFile[]): string[] {
  return files.flatMap((f) =>
    f.previousFilename ? [f.filename, f.previousFilename] : [f.filename],
  );
}

export interface GateArgs {
  pr?: number;
  branch?: string;
}

export type GateDecision =
  "ignored" | "pending" | "fix-dispatched" | "merged" | "merge-failed" | "needs-human";

async function findPull(deps: StageDeps, args: GateArgs): Promise<Pull | null> {
  if (args.pr !== undefined) return deps.gh.getPull(args.pr);
  if (args.branch) return deps.gh.findOpenPullByHead(args.branch);
  return null;
}

export async function runGate(deps: StageDeps, args: GateArgs): Promise<GateDecision> {
  const pull = await findPull(deps, args);
  if (!pull || pull.state !== "open" || pull.draft || pull.author !== deps.settings.botLogin)
    return "ignored";
  const meta = parsePrMeta(pull.body);
  if (!meta) return "ignored";
  const { state } = await readState(deps.gh, meta.issue);
  if (state !== "in-review") return "ignored";

  const checks = summarizeChecks(
    await deps.gh.listCheckRuns(pull.headSha),
    deps.policy.requiredChecks,
  );
  const verdict = latestVerdict(
    await deps.gh.listReviews(pull.number),
    deps.settings.botLogin,
    pull.headSha,
  );

  if (checks.state === "fail") {
    if (checks.failing.includes("risk-tier")) {
      await moveTo(
        deps,
        meta.issue,
        "needs-human",
        "gate",
        `PR #${pull.number}의 risk-tier 체크가 실패했다. 구현 역할 PR이 T3 경로를 바꿨거나 등급 판정이 실패했다.${runLink(deps.settings)}`,
      );
      await record(
        deps,
        stepRecord("gate", meta.issue, pull.number, false, "risk_tier", meta.round),
      );
      return "needs-human";
    }
    if (verdict?.verdict === "REQUEST_CHANGES") return "pending";
    await deps.gh.dispatchWorkflow("factory-fix.yml", {
      pr: String(pull.number),
      sha: pull.headSha,
      reason: "ci",
      issue: String(meta.issue),
    });
    return "fix-dispatched";
  }
  if (checks.state === "pending") return "pending";

  let files: ChangedFile[];
  try {
    files = await deps.gh.listPullFiles(pull.number);
  } catch (e) {
    if (!(e instanceof TooManyFilesError)) throw e;
    // 변경 파일 목록을 끝까지 얻지 못하면 등급을 알 수 없으므로 T3로 보고 사람에게 넘긴다.
    await moveTo(
      deps,
      meta.issue,
      "needs-human",
      "gate",
      `PR #${pull.number}의 변경 파일이 너무 많아 위험 등급을 판정할 수 없다. T3로 보고 자동 병합하지 않는다. 사람이 확인한다.${runLink(deps.settings)}`,
    );
    await record(
      deps,
      stepRecord("gate", meta.issue, pull.number, false, "too_many_files", meta.round),
    );
    return "needs-human";
  }
  const risk = classifyFiles(flattenFiles(files), deps.policy);
  if (risk.tier === "T2" || risk.tier === "T3") {
    const deciding = risk.files
      .filter((f) => f.tier === risk.tier)
      .map((f) => `\`${f.file}\``)
      .join(", ");
    await moveTo(
      deps,
      meta.issue,
      "needs-human",
      "gate",
      `PR #${pull.number}은 위험 등급 ${risk.tier}이므로 자동 병합하지 않는다. CODEOWNERS(@serithemage)가 승인한 뒤 사람이 병합한다. 등급을 정한 파일: ${deciding}.`,
    );
    return "needs-human";
  }
  if (verdict?.verdict === "REQUEST_CHANGES") return "pending";
  if (risk.tier === "T1" && verdict?.verdict !== "APPROVE") return "pending";

  const merged = await deps.gh.mergePull(pull.number, {
    sha: pull.headSha,
    title: `${pull.title} (#${pull.number})`,
    message: `Refs #${meta.issue}\n\n${signatureTrailers(meta.implementEngine, meta.implementModel, meta.issue)}`,
  });
  if (!merged) {
    await moveTo(
      deps,
      meta.issue,
      "needs-human",
      "gate",
      `PR #${pull.number} 자동 병합을 GitHub가 거부했다(충돌 또는 보호 규칙). 사람이 확인한다.${runLink(deps.settings)}`,
    );
    await record(
      deps,
      stepRecord("gate", meta.issue, pull.number, false, "merge_refused", meta.round),
    );
    return "merge-failed";
  }
  await record(deps, stepRecord("gate", meta.issue, pull.number, true, null, meta.round));
  return "merged";
}

export async function runOnClosed(deps: StageDeps, { pr }: { pr: number }): Promise<boolean> {
  const pull = await deps.gh.getPull(pr);
  if (!pull.merged || pull.author !== deps.settings.botLogin) return false;
  const meta = parsePrMeta(pull.body);
  if (!meta) return false;
  return moveTo(
    deps,
    meta.issue,
    "merged",
    "github",
    `PR #${pr}이 병합되었다. 프로덕션 배포와 스모크 테스트를 기다린다.`,
  );
}

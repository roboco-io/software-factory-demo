import { z } from "zod";
import { runStructured, type TimedResult } from "../agents/budget";
import { loadPrompt, renderPrompt } from "../agents/prompt";
import type { Budget, EngineName } from "../agents/types";
import { AssignmentError, assignEngines, resolveModel } from "../config/agents";
import {
  ReviewSchema,
  findTriage,
  latestVerdict,
  renderReviewBody,
  type ReviewOutput,
} from "../report/comments";
import { parsePrMeta } from "../report/pr";
import {
  TimedResultSchema,
  agentRecord,
  crashRecord,
  failureText,
  moveTo,
  readState,
  record,
  runLink,
} from "./common";
import type { StageDeps } from "./deps";
import type { PhasedStage } from "./phased";
import { clampResult } from "./protect";

export const MAX_DIFF_CHARS = 90_000;

export function truncateDiff(diff: string, max = MAX_DIFF_CHARS): string {
  if (diff.length <= max) return diff;
  return `${diff.slice(0, max)}\n... (diff가 ${max}자를 넘어 잘렸다. 전체 변경은 작업 디렉토리에서 git diff origin/main...HEAD로 확인한다)`;
}

export interface ReviewPlan {
  pr: number;
  issue: number;
  round: number;
  // prepare 시점의 PR head. 판정 표식은 이 SHA에 묶이고, publish는 PR head가 그대로일 때만 판정을 올린다.
  headSha: string;
  engine: EngineName;
  model: string;
  budget: Budget;
  authorEngine: EngineName;
  issueTitle: string;
  acceptanceCriteria: string[];
}

export interface ReviewOutcome {
  result: TimedResult;
  review: ReviewOutput | null;
}

// agent VM이 쓴 결과 파일은 신뢰할 수 없다. 판정은 이 스키마를 통과한 값만 쓴다(길이도 제한한다).
const BoundedReviewSchema = ReviewSchema.extend({
  summary: z.string().max(20_000),
  findings: z
    .array(
      z.object({
        file: z.string().max(500),
        line: z.number().int().nullable(),
        severity: z.enum(["blocker", "major", "minor"]),
        message: z.string().max(5_000),
      }),
    )
    .max(100),
});

const OutcomeSchema = z.object({
  result: TimedResultSchema,
  review: BoundedReviewSchema.nullable(),
});

// 이미 실행 기록을 남긴 계획. publish 도중 예외가 나도 crashed()가 같은 런을 다시 세지 않게 한다.
const RECORDED = new WeakSet<ReviewPlan>();

async function recordOnce(deps: StageDeps, plan: ReviewPlan, out: ReviewOutcome): Promise<void> {
  if (RECORDED.has(plan)) return;
  RECORDED.add(plan);
  // 에이전트가 ok=true로 보고하고 판정이 스키마를 통과했을 때만 성공으로 센다.
  const ok = out.result.ok && out.review !== null;
  await record(
    deps,
    agentRecord(
      "review",
      plan.engine,
      plan.model,
      clampResult(out.result, plan.budget, ok),
      plan.issue,
      plan.pr,
      plan.round,
    ),
  );
}

export const reviewStage: PhasedStage<{ pr: number }, ReviewPlan, ReviewOutcome> = {
  name: "review",
  async prepare(deps, { pr }) {
    const pull = await deps.gh.getPull(pr);
    if (pull.author !== deps.settings.botLogin || pull.state !== "open" || pull.draft) return null;
    const meta = parsePrMeta(pull.body);
    if (!meta) return null;
    const { issue, state } = await readState(deps.gh, meta.issue);
    if (state !== "in-review") return null;
    if (latestVerdict(await deps.gh.listReviews(pr), deps.settings.botLogin, pull.headSha)) {
      return null;
    }
    let engine: EngineName;
    let model: string;
    let budget: Budget;
    try {
      // 작성 엔진은 PR 표식에 기록된 값이다. 리뷰 엔진은 그 엔진과 다르게 배정된다.
      const assignment = assignEngines(deps.agents, [`agent:${meta.implementEngine}`]);
      engine = assignment.review.engine;
      budget = assignment.review.budget;
      model = resolveModel(deps.agents, engine, deps.settings.env);
    } catch (err) {
      if (!(err instanceof AssignmentError)) throw err;
      await moveTo(
        deps,
        meta.issue,
        "needs-human",
        "review",
        `PR #${pr} 리뷰 엔진을 정하지 못했다: ${err.message}${runLink(deps.settings)}`,
      );
      return null;
    }
    const triage = findTriage(await deps.gh.listComments(meta.issue), deps.settings.botLogin);
    return {
      pr,
      issue: meta.issue,
      round: meta.round,
      headSha: pull.headSha,
      engine,
      model,
      budget,
      authorEngine: meta.implementEngine,
      issueTitle: issue.title,
      acceptanceCriteria: triage?.acceptanceCriteria ?? [],
    };
  },

  async agent(deps, plan) {
    await deps.git.fetch("main");
    const diff = truncateDiff(await deps.git.diffAgainst("origin/main"));
    const prompt = renderPrompt(loadPrompt("review"), {
      authorEngine: plan.authorEngine,
      issueNumber: String(plan.issue),
      issueTitle: plan.issueTitle,
      acceptanceCriteria:
        plan.acceptanceCriteria.length > 0
          ? plan.acceptanceCriteria.map((c) => `- ${c}`).join("\n")
          : "(트리아지 수용 기준 없음)",
      diff: diff || "(변경 없음)",
    });
    const { result, value } = await runStructured(
      deps.adapterFor(plan.engine, plan.model),
      { role: "review", prompt, cwd: deps.settings.workdir, readOnly: true, budget: plan.budget },
      ReviewSchema,
    );
    return { result, review: value };
  },

  parseOutcome(raw) {
    return OutcomeSchema.parse(raw);
  },

  async publish(deps, plan, out) {
    await recordOnce(deps, plan, out);
    const { state } = await readState(deps.gh, plan.issue);
    if (state !== "in-review") {
      deps.log(`review: #${plan.issue} is ${state}; skipping verdict`);
      return;
    }
    const review = out.result.ok ? out.review : null;
    if (!review) {
      await moveTo(
        deps,
        plan.issue,
        "needs-human",
        "review",
        `PR #${plan.pr} 리뷰 에이전트가 판정을 내지 못했다(사유: ${failureText(out.result.failureReason ?? "invalid_output")}). 사람이 리뷰하거나 \`@factory retry\`로 구현부터 다시 시작한다.${runLink(deps.settings)}`,
      );
      return;
    }
    // 리뷰하는 동안 head가 바뀌었거나 다른 런이 같은 SHA의 판정을 이미 올렸으면 이 판정은 버린다.
    const pull = await deps.gh.getPull(plan.pr);
    if (pull.headSha !== plan.headSha || pull.state !== "open") {
      deps.log(`review: PR #${plan.pr} head moved to ${pull.headSha}; verdict dropped`);
      return;
    }
    if (latestVerdict(await deps.gh.listReviews(plan.pr), deps.settings.botLogin, plan.headSha)) {
      return;
    }
    await deps.gh.createReview(plan.pr, {
      event: "COMMENT",
      body: renderReviewBody(review, {
        sha: plan.headSha,
        engine: plan.engine,
        model: plan.model,
      }),
      commitId: plan.headSha,
    });
    if (review.verdict === "REQUEST_CHANGES") {
      await deps.gh.dispatchWorkflow("factory-fix.yml", {
        pr: String(plan.pr),
        sha: plan.headSha,
        reason: "review",
        issue: String(plan.issue),
      });
    } else {
      await deps.gh.dispatchWorkflow("factory-merge.yml", { pr: String(plan.pr) });
    }
  },

  async crashed(deps, plan) {
    if (!RECORDED.has(plan)) {
      RECORDED.add(plan);
      await record(deps, crashRecord("review", plan));
    }
    await moveTo(
      deps,
      plan.issue,
      "needs-human",
      "review",
      `PR #${plan.pr} 리뷰 단계가 비정상 종료했다.${runLink(deps.settings)}`,
    );
  },
};

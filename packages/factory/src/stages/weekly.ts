import { z } from "zod";
import { BranchNotFoundError, ConflictError, type MergedPull, type Review } from "../github/port";
import {
  authorShare,
  completionRate,
  engineStats,
  type EngineStat,
  type Improvement,
  isoWeek,
  type Ratio,
  type RuleEffect,
  ruleEffects,
  topFailureReasons,
  unapprovedByTier,
} from "../report/metrics";
import { cell, codeBlock, inline, neutralizeRefs, readMarker, writeMarker } from "../report/text";
import { DATA_BRANCH } from "../runs/store";
import { type Candidate, COLLECT, failureEvents, IMPROVE_MARKER, runCollect } from "./collect";
import type { StageDeps } from "./deps";
import { type BreakerState, evaluateBreaker } from "./guard";
import { REPORT_MARKER } from "./weekly-marker";

export const IMPROVEMENTS_PATH = "improvements.json";
const REPORT_LABEL = "factory:report";
const IMPROVE_LABEL = "factory:improve";
const DAY_MS = 86_400_000;
const PERIOD_DAYS = 7;
const EFFECT_DAYS = 90;
const BEFORE_DAYS = 28;
// 표식과 본문의 후보 수 상한. 이슈 본문 65,536자 제한을 넘지 않게 하며, prepare는 candidates[0]만 쓴다.
const MAX_MARKER_CANDIDATES = 5;

export interface WeeklyResult {
  issue: number;
  created: boolean;
  week: string;
  candidates: number;
}

export interface WeeklyInput {
  week: string;
  completion: Ratio;
  breaker: BreakerState;
  engines: EngineStat[];
  authors: { author: string; share: Ratio }[];
  tiers: { tier: string; share: Ratio }[];
  reasons: { reason: string; count: number }[];
  effects: RuleEffect[];
  candidates: Candidate[];
}

const ImprovementsSchema = z.array(
  z.object({ pr: z.number().int(), key: z.string(), mergedAt: z.string() }),
);

const pct = (r: number | null): string => (r === null ? "런 없음" : `${Math.round(r * 100)}%`);

function table(head: string[], rows: string[][], empty: string): string {
  if (rows.length === 0) return empty;
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

export function renderWeeklyBody(input: WeeklyInput): string {
  const b = input.breaker;
  const summary = [
    `- 무개입 완주율: ${input.completion.text}`,
    `- 차단기: ${b.tripped ? "작동" : "정상"} (implement·fix 성공률 ${pct(b.successRate)}, ${b.total}회 중 ${b.succeeded}회 성공)`,
    `- 개선 후보: ${input.candidates.length}건`,
  ].join("\n");
  const engines = table(
    ["엔진", "성공률", "비용(USD)", "비용 기록 런"],
    input.engines.map((e) => [
      cell(e.engine),
      e.runs.text,
      e.costUsd === null ? "-" : e.costUsd.toFixed(2),
      String(e.costKnown),
    ]),
    "에이전트 런 없음.",
  );
  const authors = table(
    ["작성자", "비중"],
    input.authors.map((a) => [cell(a.author), a.share.text]),
    "병합된 PR 없음.",
  );
  const tiers = table(
    ["등급", "사람 승인 없는 병합"],
    input.tiers.map((t) => [cell(t.tier), t.share.text]),
    "등급 라벨이 붙은 병합 PR 없음.",
  );
  const reasons = table(
    ["사유", "횟수"],
    input.reasons.map((r) => [cell(r.reason), String(r.count)]),
    "실패한 런 없음.",
  );
  const effects = table(
    ["범주", "PR", "병합일", `병합 전 ${BEFORE_DAYS}일`, "병합 후(경과 일수)"],
    input.effects.map((e) => [
      cell(e.key),
      `#${e.pr}`,
      cell(e.mergedAt.slice(0, 10)),
      String(e.before),
      `${e.after} (${e.afterDays}일)`,
    ]),
    "아직 병합된 개선 PR이 없다.",
  );
  const candidates =
    input.candidates.length === 0
      ? "개선 후보 없음. 이번 주에는 improve를 실행하지 않는다."
      : input.candidates
          .slice(0, MAX_MARKER_CANDIDATES)
          .map((c) =>
            [
              `### ${inline(c.key)}`,
              "",
              `- 횟수: ${c.count}`,
              `- 이슈 수: ${c.issues.length}`,
              `- 근거 이슈: ${c.issues.length > 0 ? c.issues.map((n) => `#${n}`).join(", ") : "없음"}`,
              ...(c.samples[0] ? ["", "대표 원문:", "", codeBlock(c.samples[0])] : []),
            ].join("\n"),
          )
          .join("\n\n");
  return [
    `최근 ${PERIOD_DAYS}일 팩토리 지표다. 비율은 표본이 작으면 "데이터 부족"으로 적는다.`,
    `## 요약\n\n${summary}`,
    `## 엔진별 성공률과 비용\n\n${engines}`,
    `## 병합\n\n${authors}\n\n${tiers}`,
    `## 실패 사유 상위\n\n${reasons}`,
    `## 규칙 효과\n\n최근 ${EFFECT_DAYS}일 동안 병합된 개선 PR이 대상이다.\n\n${effects}`,
    `## 개선 후보\n\n${candidates}`,
    writeMarker(REPORT_MARKER, {
      week: input.week,
      // 표식은 숨은 주석이지만 본문의 일부이므로 원문의 멘션·닫기 키워드를 같이 무력화한다.
      candidates: input.candidates.slice(0, MAX_MARKER_CANDIDATES).map((c) => ({
        ...c,
        samples: c.samples.map((x) => neutralizeRefs(x).slice(0, COLLECT.maxSampleChars)),
      })),
    }),
  ].join("\n\n");
}

function improvementOf(p: MergedPull, botLogin: string): Improvement | null {
  if (p.author !== botLogin || !p.labels.includes(IMPROVE_LABEL)) return null;
  const m = readMarker(p.body, IMPROVE_MARKER, z.object({ key: z.string() }));
  return m ? { pr: p.number, key: m.key, mergedAt: p.mergedAt } : null;
}

// factory-data:improvements.json에 새 개선 PR을 더한다(pr 기준 중복 제거). 충돌이면 한 번 다시 시도한다.
async function saveImprovements(
  deps: StageDeps,
  fresh: Improvement[],
  week: string,
): Promise<Improvement[]> {
  let createdBranch = false;
  for (let attempt = 1; ; attempt++) {
    const cur = await deps.gh.readFile(DATA_BRANCH, IMPROVEMENTS_PATH);
    let prev: Improvement[] = [];
    if (cur) {
      try {
        prev = ImprovementsSchema.parse(JSON.parse(cur.content));
      } catch {
        // 기록이 사라지지 않도록 덮어쓰지 않고 중단한다.
        throw new Error(
          `${DATA_BRANCH}:${IMPROVEMENTS_PATH}를 읽을 수 없다(JSON이 아니거나 형식이 다르다). 기록 보존을 위해 덮어쓰지 않는다. 파일을 확인하라.`,
        );
      }
    }
    const byPr = new Map(prev.map((i) => [i.pr, i]));
    for (const i of fresh) byPr.set(i.pr, i);
    const all = [...byPr.values()].sort((a, b) => a.pr - b.pr);
    const content = `${JSON.stringify(all, null, 2)}\n`;
    if (cur?.content === content) return all;
    try {
      await deps.gh.writeFile(
        DATA_BRANCH,
        IMPROVEMENTS_PATH,
        content,
        cur?.sha ?? null,
        `report: improvements ${week}`,
      );
      return all;
    } catch (e) {
      if (e instanceof BranchNotFoundError && !createdBranch) {
        createdBranch = true;
        await deps.gh.createOrphanBranch(
          DATA_BRANCH,
          { "README.md": "factory run records\n" },
          "init factory-data",
        );
        attempt--;
        continue;
      }
      if (!(e instanceof ConflictError) || attempt >= 2) throw e;
    }
  }
}

export async function runWeeklyReport(deps: StageDeps): Promise<WeeklyResult> {
  const now = deps.now();
  const week = isoWeek(now);
  const periodFrom = new Date(now.getTime() - PERIOD_DAYS * DAY_MS);
  const effectFrom = new Date(now.getTime() - EFFECT_DAYS * DAY_MS);
  const eventsFrom = new Date(effectFrom.getTime() - BEFORE_DAYS * DAY_MS);

  const collected = await runCollect(deps);
  const [allRuns, commits, pulls] = await Promise.all([
    deps.runs.since(eventsFrom),
    deps.gh.listCommits(eventsFrom),
    deps.gh.listMergedPulls(effectFrom),
  ]);
  const events = failureEvents(allRuns, commits);
  const runs = allRuns.filter((r) => Date.parse(r.ts) >= periodFrom.getTime());
  const recentPulls = pulls.filter((p) => Date.parse(p.mergedAt) >= periodFrom.getTime());
  const reviews = new Map<number, Review[]>();
  for (const p of recentPulls) reviews.set(p.number, await deps.gh.listReviews(p.number));

  const fresh = pulls
    .map((p) => improvementOf(p, deps.settings.botLogin))
    .filter((i): i is Improvement => i !== null);
  const improvements = await saveImprovements(deps, fresh, week);

  const body = renderWeeklyBody({
    week,
    completion: completionRate(runs),
    breaker: evaluateBreaker(allRuns, now),
    engines: engineStats(runs),
    authors: authorShare(recentPulls),
    tiers: unapprovedByTier(recentPulls, reviews, deps.settings.botLogin),
    reasons: topFailureReasons(runs),
    effects: ruleEffects(
      improvements.filter((i) => Date.parse(i.mergedAt) >= effectFrom.getTime()),
      events,
      now,
    ),
    candidates: collected.candidates,
  });

  const title = `주간 리포트 ${week}`;
  const existing = (await deps.gh.listOpenIssues())
    .filter(
      (i) =>
        !i.isPullRequest &&
        i.labels.includes(REPORT_LABEL) &&
        i.author === deps.settings.botLogin &&
        i.title === title,
    )
    .sort((a, b) => a.number - b.number)[0];
  const result = { week, candidates: collected.candidates.length };
  if (existing) {
    await deps.gh.comment(existing.number, body);
    return { issue: existing.number, created: false, ...result };
  }
  const issue = await deps.gh.createIssue(title, body, [REPORT_LABEL]);
  return { issue, created: true, ...result };
}

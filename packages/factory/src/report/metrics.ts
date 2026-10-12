// 완주 판정·범주 키 정의는 apps/web/src/factory/metrics.ts(대시보드)에 복사되어 있다. 한쪽을 바꾸면 다른 쪽도 바꾼다.
import type { MergedPull, Review } from "../github/port";
import type { RunRecord } from "../runs/store";
import { type FailureEvent, IGNORED_REASONS } from "../stages/collect";

// 표본이 이보다 작으면 비율 대신 "데이터 부족"을 쓴다.
export const MIN_SAMPLE = 5;
const DAY_MS = 86_400_000;
const BEFORE_DAYS = 28;
const AGENT_ROLES = new Set(["triage", "implement", "review", "fix", "improve"]);

export interface Ratio {
  k: number;
  n: number;
  text: string;
}

export function ratio(k: number, n: number): Ratio {
  const text =
    n < MIN_SAMPLE ? `데이터 부족 (n=${n})` : `${Math.round((k / n) * 100)}% (${k}/${n})`;
  return { k, n, text };
}

// ISO 8601 주(월요일 시작, 목요일이 속한 해). UTC 기준.
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

// implement 런이 있는 이슈 가운데 deploy 성공 기록이 있고 실패한 런이 하나도 없는 이슈의 비율.
// 정책 보류(risk_t2 등)도 사람 개입이므로 실패로 센다.
// 입력 runs는 호출자가 7일 창으로 먼저 거른 것이며, 이슈별 판정은 그 창 안의 런만 대상으로 한다.
export function completionRate(runs: RunRecord[]): Ratio {
  const implemented = new Set(
    runs.filter((r) => r.role === "implement" && r.issue > 0).map((r) => r.issue),
  );
  let done = 0;
  for (const issue of implemented) {
    const mine = runs.filter((r) => r.issue === issue);
    if (mine.some((r) => r.role === "deploy" && r.ok) && mine.every((r) => r.ok)) done++;
  }
  return ratio(done, implemented.size);
}

export interface EngineStat {
  engine: string;
  runs: Ratio;
  costUsd: number | null;
  costKnown: number;
}

export function engineStats(runs: RunRecord[]): EngineStat[] {
  const byEngine = new Map<string, RunRecord[]>();
  for (const r of runs) {
    if (!AGENT_ROLES.has(r.role) || !r.engine) continue;
    byEngine.set(r.engine, [...(byEngine.get(r.engine) ?? []), r]);
  }
  return [...byEngine.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([engine, list]) => {
      const costs = list.map((r) => r.costUsd).filter((c): c is number => typeof c === "number");
      return {
        engine,
        runs: ratio(list.filter((r) => r.ok).length, list.length),
        costUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
        costKnown: costs.length,
      };
    });
}

function countBy<T>(items: T[], key: (t: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + 1);
  return [...m.entries()].sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
}

export function authorShare(pulls: MergedPull[]): { author: string; share: Ratio }[] {
  return countBy(pulls, (p) => p.author).map(([author, k]) => ({
    author,
    share: ratio(k, pulls.length),
  }));
}

// risk:Tn 라벨별로, 사람(봇이 아닌 계정)의 APPROVED 리뷰 없이 병합된 PR의 비율.
export function unapprovedByTier(
  pulls: MergedPull[],
  reviews: Map<number, Review[]>,
  botLogin: string,
): { tier: string; share: Ratio }[] {
  const byTier = new Map<string, { k: number; n: number }>();
  for (const p of pulls) {
    const tier = p.labels.find((l) => /^risk:T\d$/.test(l))?.slice("risk:".length);
    if (!tier) continue;
    const approved = (reviews.get(p.number) ?? []).some(
      (r) => r.state === "APPROVED" && r.author !== botLogin && !r.author.endsWith("[bot]"),
    );
    const cur = byTier.get(tier) ?? { k: 0, n: 0 };
    byTier.set(tier, { k: cur.k + (approved ? 0 : 1), n: cur.n + 1 });
  }
  return [...byTier.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tier, { k, n }]) => ({ tier, share: ratio(k, n) }));
}

export function topFailureReasons(
  runs: RunRecord[],
  limit = 5,
): { reason: string; count: number }[] {
  return countBy(
    // 정책 보류(risk_t2/risk_t3/permission_denied)는 실패가 아니므로 제외한다.
    runs.filter(
      (r) => !r.ok && !(IGNORED_REASONS as readonly string[]).includes(r.failureReason ?? ""),
    ),
    (r) => r.failureReason ?? "unknown",
  )
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }));
}

export interface Improvement {
  pr: number;
  key: string;
  mergedAt: string;
}

export interface RuleEffect {
  pr: number;
  key: string;
  mergedAt: string;
  before: number;
  after: number;
  afterDays: number;
}

// before: 병합 전 28일 동안의 같은 범주 이벤트 수. after: 병합 시점부터 now까지.
export function ruleEffects(
  improvements: Improvement[],
  events: FailureEvent[],
  now: Date,
): RuleEffect[] {
  return improvements.map((imp) => {
    const merged = Date.parse(imp.mergedAt);
    const ts = events.filter((e) => e.key === imp.key).map((e) => Date.parse(e.ts));
    return {
      ...imp,
      before: ts.filter((t) => t >= merged - BEFORE_DAYS * DAY_MS && t < merged).length,
      after: ts.filter((t) => t >= merged && t <= now.getTime()).length,
      afterDays: Math.floor((now.getTime() - merged) / DAY_MS),
    };
  });
}

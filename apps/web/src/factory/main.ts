import "./factory.css";
import { loadImprovements, loadRuns, type Run } from "./data";
import {
  activeWeeks,
  categoryTrend,
  engineSummary,
  isoWeek,
  lastWeeks,
  MIN_SAMPLE,
  recentRuns,
  summary,
  weeklyCompletion,
} from "./metrics";
import { barChart, lineChart } from "./svg";

const WEEKS = 8;
const REPO = "https://github.com/roboco-io/software-factory-demo";
const ROLE_LABEL: Record<string, string> = {
  triage: "트리아지",
  command: "명령",
  implement: "구현",
  review: "리뷰",
  fix: "수정",
  gate: "병합 판단",
  deploy: "배포",
  smoke: "스모크",
  improve: "자기개선",
};

const HOLD_LABEL: Record<string, string> = {
  risk_t2: "보류: 사람 승인 필요(T2)",
  risk_t3: "보류: 사람 승인 필요(T3)",
  permission_denied: "거부: 명령 권한 없음",
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
}

function cards(root: HTMLElement, items: { label: string; value: string; note: string }[]): void {
  const box = el("div", undefined, "cards");
  for (const i of items) {
    const c = el("div", undefined, "card");
    c.append(
      el("div", i.label, "card-label"),
      el("div", i.value, "card-value"),
      el("div", i.note, "card-note"),
    );
    box.append(c);
  }
  root.append(box);
}

const pct = (k: number, n: number) => `${Math.round((k / n) * 100)}%`;
const utc = (ts: string) => `${ts.slice(5, 10)} ${ts.slice(11, 16)}`;

function recentTable(root: HTMLElement, runs: Run[]): void {
  const s = el("section");
  s.append(el("h2", "최근 런"));
  const t = el("table");
  const head = el("tr");
  for (const h of ["시각(UTC)", "이슈", "단계", "엔진", "결과"]) head.append(el("th", h));
  t.append(head);
  for (const r of runs) {
    const tr = el("tr");
    const issue = el("td");
    if (r.issue > 0) {
      const a = el("a", `#${r.issue}`);
      a.href = `${REPO}/issues/${r.issue}`;
      issue.append(a);
    } else issue.textContent = "-";
    // 위험 등급 보류와 권한 거부는 정책이 정한 정상 동작이므로 실패와 구분한다.
    const hold = r.ok ? undefined : HOLD_LABEL[r.failureReason ?? ""];
    const result = r.ok
      ? "성공"
      : (hold ?? `실패${r.failureReason ? ` (${r.failureReason})` : ""}`);
    tr.append(
      el("td", utc(r.ts)),
      issue,
      el("td", ROLE_LABEL[r.role] ?? r.role),
      el("td", r.engine ?? "-"),
      el("td", result, r.ok ? "ok" : hold ? "hold" : "fail"),
    );
    t.append(tr);
  }
  s.append(runs.length ? t : el("p", "런 기록이 없다.", "note"));
  root.append(s);
}

function section(root: HTMLElement, title: string, svg: string, note?: string): void {
  const s = document.createElement("section");
  const h = document.createElement("h2");
  h.textContent = title;
  const fig = document.createElement("div");
  fig.innerHTML = svg; // svg.ts가 만든 이스케이프된 문자열만 넣는다.
  s.append(h, fig);
  if (note) {
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = note;
    s.append(p);
  }
  root.append(s);
}

async function render(root: HTMLElement): Promise<void> {
  const now = new Date();
  const [runs, improvements] = await Promise.all([
    loadRuns(now, fetch.bind(window)),
    loadImprovements(fetch.bind(window)),
  ]);
  const weeks = activeWeeks(runs, lastWeeks(now, WEEKS));

  const sum = summary(runs, improvements.length);
  const { k, n } = sum.completion;
  cards(root, [
    { label: "배포까지 끝난 이슈", value: String(sum.deployed), note: "최근 3개월" },
    {
      label: "무개입 완주율",
      value: n < MIN_SAMPLE ? "데이터 부족" : pct(k, n),
      note: `${k}/${n} 이슈, 사람 개입·실패 없이 배포`,
    },
    {
      label: "에이전트 비용",
      value: `$${sum.costUsd.toFixed(2)}`,
      note: sum.uncostedEngines.length
        ? `${sum.uncostedEngines.join(", ")}는 비용 미보고`
        : "모든 엔진 기록 기준",
    },
    { label: "병합된 개선 규칙", value: String(sum.improvements), note: "자기개선 루프가 추가" },
  ]);

  const completion = weeklyCompletion(runs, weeks);
  section(
    root,
    "주별 무개입 완주율",
    lineChart({
      labels: weeks.map((w) => w.slice(5)),
      series: [
        {
          name: "무개입 완주율",
          values: completion.map((c) => (c.n < MIN_SAMPLE ? null : c.k / c.n)),
          titles: completion.map((c) =>
            c.n < MIN_SAMPLE
              ? `데이터 부족 (n=${c.n})`
              : `${Math.round((c.k / c.n) * 100)}% (${c.k}/${c.n})`,
          ),
        },
      ],
      yMax: 1,
      percent: true,
      valueLabels: true,
    }),
    `이슈 ${MIN_SAMPLE}건 미만인 주는 점을 그리지 않는다.`,
  );

  const engines = engineSummary(runs);
  const rate = barChart({
    labels: engines.map((e) => e.engine),
    values: engines.map((e) => (e.n ? Math.round((e.ok / e.n) * 100) : 0)),
    valueText: engines.map((e) => `${e.n ? pct(e.ok, e.n) : "-"} (${e.ok}/${e.n})`),
  });
  section(
    root,
    "엔진별 성공률(%)",
    engines.length ? rate : "",
    engines
      .map((e) => `${e.engine} 비용 ${e.costRuns ? `$${e.costUsd.toFixed(2)}` : "기록 없음"}`)
      .join(" / ") || "에이전트 런 기록이 없다.",
  );

  const trend = categoryTrend(runs, weeks);
  const markers = improvements
    .map((i) => ({ index: weeks.indexOf(isoWeek(new Date(i.mergedAt))), label: `#${i.pr}` }))
    .filter((m) => m.index >= 0);
  section(
    root,
    "실패 범주 추이(상위 3)",
    lineChart({
      labels: weeks.map((w) => w.slice(5)),
      series: trend.map((t) => ({
        name: `${t.key} (${t.counts.reduce((a, b) => a + b, 0)})`,
        values: t.counts,
      })),
      markers,
    }),
    trend.length
      ? "범례의 괄호 안은 기간 합계다. 점선은 개선 규칙(PR)이 병합된 주다."
      : "실패 이벤트가 없다.",
  );

  recentTable(root, recentRuns(runs, 10));
}

const root = document.getElementById("factory");
if (root) {
  const h1 = document.createElement("h1");
  h1.textContent = "소프트웨어 팩토리 대시보드";
  root.append(h1);
  render(root)
    .catch((e: unknown) => {
      const p = document.createElement("p");
      p.className = "error";
      p.textContent = `런 기록을 불러오지 못했다: ${e instanceof Error ? e.message : String(e)}`;
      root.append(p);
    })
    .finally(() => {
      const f = document.createElement("p");
      f.className = "note";
      const a = document.createElement("a");
      a.href = "https://github.com/roboco-io/software-factory-demo/tree/factory-data";
      a.textContent = "factory-data 브랜치";
      f.append("데이터: ", a, " 런 기록(GitHub 캐시로 최대 5분 지연)");
      root.append(f);
    });
}

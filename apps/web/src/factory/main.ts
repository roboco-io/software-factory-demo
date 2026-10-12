import "./factory.css";
import { loadImprovements, loadRuns } from "./data";
import {
  categoryTrend,
  engineSummary,
  isoWeek,
  lastWeeks,
  MIN_SAMPLE,
  weeklyCompletion,
} from "./metrics";
import { barChart, lineChart } from "./svg";

const WEEKS = 8;

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
  const weeks = lastWeeks(now, WEEKS);

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
    }),
    `이슈 ${MIN_SAMPLE}건 미만인 주는 점을 그리지 않는다.`,
  );

  const engines = engineSummary(runs);
  const rate = barChart({
    labels: engines.map((e) => e.engine),
    values: engines.map((e) => (e.n ? Math.round((e.ok / e.n) * 100) : 0)),
  });
  section(
    root,
    "엔진별 성공률(%)",
    engines.length ? rate : "",
    engines.map((e) => `${e.engine}: ${e.ok}/${e.n}, 비용 $${e.costUsd.toFixed(2)}`).join(" / ") ||
      "에이전트 런 기록이 없다.",
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
      series: trend.map((t) => ({ name: t.key, values: t.counts })),
      markers,
    }),
    trend.length ? undefined : "실패 이벤트가 없다.",
  );
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

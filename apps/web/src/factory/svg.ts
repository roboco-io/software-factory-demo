export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea"];
const PAD = { l: 40, r: 12, t: 16, b: 32 };

function frame(width: number, height: number, yMax: number, fmt: (v: number) => string): string {
  const h = height - PAD.t - PAD.b;
  let out = "";
  for (let i = 0; i <= 4; i++) {
    const y = PAD.t + h - (h * i) / 4;
    out += `<line x1="${PAD.l}" x2="${width - PAD.r}" y1="${y}" y2="${y}" stroke="#e5e7eb"/>`;
    out += `<text x="${PAD.l - 6}" y="${y + 4}" text-anchor="end" font-size="11" fill="#6b7280">${esc(fmt((yMax * i) / 4))}</text>`;
  }
  return out;
}

function xLabels(labels: string[], width: number, height: number, xs: number[]): string {
  const step = Math.max(1, Math.ceil(labels.length / 8));
  return labels
    .map((l, i) =>
      i % step === 0
        ? `<text x="${xs[i]}" y="${height - 10}" text-anchor="middle" font-size="11" fill="#6b7280">${esc(l)}</text>`
        : "",
    )
    .join("");
}

export function lineChart(input: {
  labels: string[];
  series: { name: string; values: (number | null)[]; titles?: string[] }[];
  markers?: { index: number; label: string }[];
  width?: number;
  height?: number;
  yMax?: number;
  percent?: boolean;
  valueLabels?: boolean;
}): string {
  const {
    labels,
    series,
    markers = [],
    width = 640,
    height = 240,
    percent = false,
    valueLabels = false,
  } = input;
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  // 횟수 축은 눈금 4칸이 모두 정수가 되도록 최댓값을 4의 배수로 올린다.
  const yMax =
    input.yMax ?? (percent ? Math.max(1, ...all) : Math.ceil(Math.max(1, ...all) / 4) * 4);
  const w = width - PAD.l - PAD.r;
  const h = height - PAD.t - PAD.b;
  const xs = labels.map(
    (_, i) => PAD.l + (labels.length < 2 ? w / 2 : (w * i) / (labels.length - 1)),
  );
  const y = (v: number) => PAD.t + h - (h * v) / yMax;
  const fmt = percent
    ? (v: number) => `${Math.round(v * 100)}%`
    : (v: number) => String(Math.round(v * 10) / 10);
  // 값이 같은 선이 서로 가리지 않도록 계열마다 몇 픽셀씩 어긋나게 그린다.
  const offset = (si: number) => (series.length < 2 ? 0 : (si - (series.length - 1) / 2) * 3);
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" role="img">`;
  out += frame(width, height, yMax, fmt);
  for (const m of markers) {
    const x = xs[m.index];
    if (x === undefined) continue;
    out += `<line x1="${x}" x2="${x}" y1="${PAD.t}" y2="${PAD.t + h}" stroke="#f59e0b" stroke-dasharray="4 3"/>`;
    // 오른쪽 끝 근처의 라벨은 선 왼쪽에 붙여 잘리지 않게 한다.
    const right = x > width - PAD.r - 40;
    out += `<text x="${right ? x - 3 : x + 3}" y="${PAD.t + 10}"${right ? ' text-anchor="end"' : ""} font-size="11" fill="#b45309">${esc(m.label)}</text>`;
  }
  series.forEach((s, si) => {
    const color = COLORS[si % COLORS.length];
    let d = "";
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${xs[i]} ${y(v) + offset(si)} `;
      pen = true;
    });
    if (d) out += `<path d="${d.trim()}" fill="none" stroke="${color}" stroke-width="2"/>`;
    s.values.forEach((v, i) => {
      if (v === null) return;
      const title = s.titles?.[i] ?? `${s.name} ${labels[i] ?? ""}: ${fmt(v)}`;
      out += `<circle cx="${xs[i]}" cy="${y(v) + offset(si)}" r="4" fill="${color}"><title>${esc(title)}</title></circle>`;
      if (valueLabels)
        out += `<text x="${xs[i]}" y="${y(v) - 8}" text-anchor="middle" font-size="11" font-weight="600" fill="${color}">${esc(fmt(v))}</text>`;
    });
  });
  out += xLabels(labels, width, height, xs);
  // 값이 없는 점에도 툴팁이 필요한 경우(데이터 부족)를 위해 투명 영역을 둔다.
  series.forEach((s) =>
    s.values.forEach((v, i) => {
      const t = s.titles?.[i];
      if (v === null && t)
        out += `<rect x="${(xs[i] ?? 0) - 10}" y="${PAD.t}" width="20" height="${h}" fill="transparent"><title>${esc(t)}</title></rect>`;
    }),
  );
  out += legend(
    series.map((s) => s.name),
    width,
  );
  return out + "</svg>";
}

function legend(names: string[], width: number): string {
  if (names.length < 2) return "";
  let x = PAD.l;
  return names
    .map((n, i) => {
      const s = `<rect x="${x}" y="2" width="10" height="10" fill="${COLORS[i % COLORS.length]}"/><text x="${x + 14}" y="11" font-size="11" fill="#374151">${esc(n)}</text>`;
      x += 24 + n.length * 7;
      return x < width ? s : "";
    })
    .join("");
}

export function barChart(input: {
  labels: string[];
  values: number[];
  valueText?: string[];
  width?: number;
  height?: number;
}): string {
  const { labels, values, valueText, width = 640, height = 240 } = input;
  const yMax = Math.max(1, ...values);
  const w = width - PAD.l - PAD.r;
  const h = height - PAD.t - PAD.b;
  const slot = w / Math.max(1, labels.length);
  const xs = labels.map((_, i) => PAD.l + slot * i + slot / 2);
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" role="img">`;
  out += frame(width, height, yMax, (v) => String(Math.round(v * 10) / 10));
  values.forEach((v, i) => {
    const bh = (h * v) / yMax;
    out += `<rect x="${(xs[i] ?? 0) - slot * 0.3}" y="${PAD.t + h - bh}" width="${slot * 0.6}" height="${bh}" fill="${COLORS[0]}"><title>${esc(`${labels[i] ?? ""}: ${v}`)}</title></rect>`;
    const t = valueText?.[i];
    if (t)
      // 막대가 짧으면 글자를 막대 위에 어두운 색으로 쓴다.
      out +=
        bh >= 20
          ? `<text x="${xs[i] ?? 0}" y="${PAD.t + h - bh + 14}" text-anchor="middle" font-size="11" font-weight="600" fill="#fff">${esc(t)}</text>`
          : `<text x="${xs[i] ?? 0}" y="${PAD.t + h - bh - 4}" text-anchor="middle" font-size="11" font-weight="600" fill="#374151">${esc(t)}</text>`;
  });
  out += xLabels(labels, width, height, xs);
  return out + "</svg>";
}

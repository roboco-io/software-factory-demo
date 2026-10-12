import { describe, expect, it } from "vitest";
import { barChart, lineChart } from "./svg";

describe("svg", () => {
  it("escapes labels so data cannot inject markup", () => {
    const s = barChart({ labels: ['<img src=x onerror="alert(1)">'], values: [1] });
    expect(s).not.toContain("<img");
    expect(s).toContain("&lt;img");
  });
  it("draws no point for a null value and keeps a marker line", () => {
    const s = lineChart({
      labels: ["W1", "W2"],
      series: [{ name: "a", values: [null, 0.5] }],
      markers: [{ index: 1, label: "#9" }],
    });
    expect(s.match(/<circle/g)).toHaveLength(1);
    expect(s).toContain("#9");
  });
  it("uses integer ticks for counts", () => {
    const s = lineChart({ labels: ["W1", "W2"], series: [{ name: "a", values: [0, 2] }] });
    expect(s).not.toMatch(/>\d+\.\d+</);
    expect(s).toContain(">4<");
  });
  it("anchors a marker label at the right edge to the left of its line", () => {
    const s = lineChart({
      labels: ["W1", "W2"],
      series: [{ name: "a", values: [1, 2] }],
      markers: [{ index: 1, label: "#47" }],
    });
    expect(s).toMatch(/text-anchor="end"[^>]*>#47</);
  });
  it("offsets overlapping series so each line stays visible", () => {
    const s = lineChart({
      labels: ["W1", "W2"],
      series: [
        { name: "a", values: [0, 1] },
        { name: "b", values: [0, 1] },
      ],
    });
    const cys = [...s.matchAll(/<circle cx="[^"]+" cy="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(cys).size).toBe(4);
  });
  it("labels point and bar values when asked", () => {
    const line = lineChart({
      labels: ["W1", "W2"],
      series: [{ name: "a", values: [null, 0.86] }],
      yMax: 1,
      percent: true,
      valueLabels: true,
    });
    expect(line).toContain(">86%<");
    const bar = barChart({ labels: ["claude"], values: [100], valueText: ["100% (16/16)"] });
    expect(bar).toContain(">100% (16/16)<");
  });
});

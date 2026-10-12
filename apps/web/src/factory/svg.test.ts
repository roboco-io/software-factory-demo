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
});

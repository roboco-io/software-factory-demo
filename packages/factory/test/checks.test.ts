import { describe, expect, it } from "vitest";
import { formatCheckFailures, runChecks, tail } from "../src/exec/checks";
import { scriptedSpawn } from "./helpers";

describe("runChecks", () => {
  it("runs typecheck, lint and test in order and reports each result", async () => {
    const spawn = scriptedSpawn({ lint: [1] });
    const r = await runChecks(spawn, "/work", { PATH: "/bin" });
    expect(spawn.calls).toEqual(["pnpm typecheck", "pnpm lint", "pnpm test"]);
    expect(r.ok).toBe(false);
    expect(r.results.map((x) => [x.name, x.ok])).toEqual([
      ["typecheck", true],
      ["lint", false],
      ["test", true],
    ]);
    expect(formatCheckFailures(r.results)).toContain("### pnpm lint 실패");
  });

  it("keeps only the tail of long output", () => {
    const t = tail("x".repeat(5000), 4000);
    expect(t.endsWith("x".repeat(4000))).toBe(true);
    expect(t.startsWith("...(앞부분 생략)")).toBe(true);
  });
});

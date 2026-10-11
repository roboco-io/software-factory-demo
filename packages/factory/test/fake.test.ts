import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeAdapter, loadFakeScript } from "../src/agents/fake";
import type { AgentTask } from "../src/agents/types";

const task = (cwd: string, readOnly = false): AgentTask => ({
  role: "implement",
  prompt: "p",
  cwd,
  readOnly,
  budget: { maxTurns: 5, timeoutMs: 1_000 },
});

describe("FakeAdapter", () => {
  it("replays steps in order and records calls", async () => {
    const a = createFakeAdapter([{ result: { summary: "one" } }, { result: { summary: "two" } }]);
    const dir = mkdtempSync(path.join(tmpdir(), "fake-"));
    expect((await a.run(task(dir))).summary).toBe("one");
    expect((await a.run(task(dir))).summary).toBe("two");
    expect(a.calls).toHaveLength(2);
    await expect(a.run(task(dir))).rejects.toThrow(/script exhausted/);
  });

  it("writes files inside cwd", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-"));
    const a = createFakeAdapter([{ writeFiles: { "apps/api/src/x.ts": "export {};\n" } }]);
    expect((await a.run(task(dir))).ok).toBe(true);
    expect(readFileSync(path.join(dir, "apps/api/src/x.ts"), "utf8")).toBe("export {};\n");
  });

  it("fails a read-only task that tries to write, without writing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-"));
    const a = createFakeAdapter([{ writeFiles: { "x.txt": "x" } }]);
    const r = await a.run(task(dir, true));
    expect(r).toMatchObject({ ok: false, failureReason: "engine_error" });
    expect(existsSync(path.join(dir, "x.txt"))).toBe(false);
  });

  it("refuses paths that escape cwd", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-"));
    const a = createFakeAdapter([{ writeFiles: { "../escape.txt": "x" } }]);
    await expect(a.run(task(dir))).rejects.toThrow(/escapes cwd/);
  });

  it("loads the shared fixtures", () => {
    expect(loadFakeScript("triage-feature")).toHaveLength(1);
    expect(loadFakeScript("implement-budget-exceeded")[0]?.result?.failureReason).toBe("budget");
  });
});

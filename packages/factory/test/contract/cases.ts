import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runWithBudget } from "../../src/agents/budget";
import type { AgentAdapter } from "../../src/agents/types";

const PROMPT = "Create a file named hello.txt in the current directory containing exactly: hello";

// 실제 엔진 호출. FACTORY_CONTRACT=1과 엔진 키가 있을 때만 실행한다.
export function defineContract(name: string, make: () => AgentAdapter): void {
  describe.skipIf(process.env.FACTORY_CONTRACT !== "1")(`${name} adapter contract`, () => {
    it("write mode creates the requested file", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), `contract-${name}-`));
      const r = await runWithBudget(make(), {
        role: "implement",
        prompt: PROMPT,
        cwd: dir,
        readOnly: false,
        budget: { maxTurns: 8, timeoutMs: 300_000, maxUsd: 0.5 },
      });
      expect(r.ok, r.summary).toBe(true);
      expect(readFileSync(path.join(dir, "hello.txt"), "utf8").trim()).toBe("hello");
    });

    it("read-only mode does not create the file", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), `contract-${name}-ro-`));
      await runWithBudget(make(), {
        role: "review",
        prompt: PROMPT,
        cwd: dir,
        readOnly: true,
        budget: { maxTurns: 8, timeoutMs: 300_000, maxUsd: 0.5 },
      });
      expect(existsSync(path.join(dir, "hello.txt"))).toBe(false);
    });
  });
}

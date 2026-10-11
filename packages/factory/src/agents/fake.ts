import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FACTORY_DIR } from "../paths";
import { failedResult, type AgentAdapter, type AgentResult, type AgentTask } from "./types";

export interface FakeStep {
  result?: Partial<AgentResult>;
  writeFiles?: Record<string, string>;
}

export interface FakeAdapter extends AgentAdapter {
  readonly calls: AgentTask[];
}

export function createFakeAdapter(
  steps: FakeStep[],
  name: AgentAdapter["name"] = "fake",
): FakeAdapter {
  const queue = [...steps];
  const calls: AgentTask[] = [];
  return {
    name,
    calls,
    async run(task) {
      calls.push(task);
      const step = queue.shift();
      if (!step) throw new Error(`fake adapter ${name}: script exhausted at call ${calls.length}`);
      if (step.writeFiles) {
        if (task.readOnly) {
          return failedResult(
            "fake",
            "engine_error",
            "read-only violation: fake step tried to write",
          );
        }
        const root = path.resolve(task.cwd);
        for (const [rel, content] of Object.entries(step.writeFiles)) {
          const abs = path.resolve(root, rel);
          if (!abs.startsWith(root + path.sep)) throw new Error(`path escapes cwd: ${rel}`);
          mkdirSync(path.dirname(abs), { recursive: true });
          writeFileSync(abs, content);
        }
      }
      return {
        ok: true,
        summary: "",
        model: "fake",
        turns: 1,
        costUsd: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        ...step.result,
      };
    },
  };
}

export function loadFakeScript(
  name: string,
  dir = path.join(FACTORY_DIR, "test-fixtures"),
): FakeStep[] {
  return JSON.parse(readFileSync(path.join(dir, `${name}.json`), "utf8")) as FakeStep[];
}

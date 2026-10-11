import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractJson, runStructured, runWithBudget } from "../src/agents/budget";
import { createFakeAdapter } from "../src/agents/fake";
import type { AgentAdapter, AgentTask } from "../src/agents/types";

const task = (over: Partial<AgentTask> = {}): AgentTask => ({
  role: "triage",
  prompt: "p",
  cwd: process.cwd(),
  readOnly: true,
  budget: { maxTurns: 5, timeoutMs: 1_000, maxUsd: 1 },
  ...over,
});

describe("runWithBudget", () => {
  it("returns a timeout failure when the adapter never finishes, and aborts the signal", async () => {
    let seen: AbortSignal | undefined;
    const hang: AgentAdapter = {
      name: "fake",
      run: (t) => {
        seen = t.signal;
        return new Promise(() => undefined);
      },
    };
    const r = await runWithBudget(hang, task({ budget: { maxTurns: 5, timeoutMs: 30 } }));
    expect(r.ok).toBe(false);
    expect(r.failureReason).toBe("timeout");
    expect(seen?.aborted).toBe(true);
  });

  it("converts a thrown error into engine_error", async () => {
    const boom: AgentAdapter = { name: "fake", run: () => Promise.reject(new Error("boom")) };
    const r = await runWithBudget(boom, task());
    expect(r).toMatchObject({ ok: false, failureReason: "engine_error", summary: "boom" });
  });

  it("enforces maxTurns and maxUsd that the engine did not enforce", async () => {
    const turns = await runWithBudget(createFakeAdapter([{ result: { turns: 6 } }]), task());
    expect(turns.failureReason).toBe("max_turns");
    const cost = await runWithBudget(createFakeAdapter([{ result: { costUsd: 1.5 } }]), task());
    expect(cost.failureReason).toBe("budget");
  });

  it("converts a synchronous throw from adapter.run into engine_error", async () => {
    const boom: AgentAdapter = {
      name: "fake",
      run: () => {
        throw new Error("sync boom");
      },
    };
    const r = await runWithBudget(boom, task());
    expect(r).toMatchObject({ ok: false, failureReason: "engine_error", summary: "sync boom" });
  });

  it("measures duration with the injected clock", async () => {
    let t = 1_000;
    const r = await runWithBudget(createFakeAdapter([{}]), task(), () => (t += 250));
    expect(r.ok).toBe(true);
    expect(r.durationMs).toBe(250);
  });
});

describe("runStructured", () => {
  const Schema = z.object({ verdict: z.enum(["APPROVE", "REQUEST_CHANGES"]) });

  it("parses fenced JSON on the first attempt", async () => {
    const a = createFakeAdapter([
      { result: { summary: 'ok\n```json\n{"verdict":"APPROVE"}\n```' } },
    ]);
    const r = await runStructured(a, task(), Schema);
    expect(r.value).toEqual({ verdict: "APPROVE" });
    expect(r.result.structured).toEqual({ verdict: "APPROVE" });
  });

  it("retries once with the validation error and sums turns", async () => {
    const a = createFakeAdapter([
      { result: { summary: '{"verdict":"MAYBE"}', turns: 2 } },
      { result: { summary: '{"verdict":"REQUEST_CHANGES"}', turns: 1 } },
    ]);
    const r = await runStructured(a, task(), Schema);
    expect(r.value?.verdict).toBe("REQUEST_CHANGES");
    expect(r.result.turns).toBe(3);
    expect(a.calls[1]?.prompt).toContain("JSON 스키마를 만족하지 않았다");
  });

  it("fails with max_turns when each attempt is within budget but the sum is not", async () => {
    const a = createFakeAdapter([
      { result: { summary: "{}", turns: 2 } },
      { result: { summary: '{"verdict":"APPROVE"}', turns: 2 } },
    ]);
    const r = await runStructured(a, task({ budget: { maxTurns: 3, timeoutMs: 1_000 } }), Schema);
    expect(r.value).toBeNull();
    expect(r.result).toMatchObject({ ok: false, failureReason: "max_turns", turns: 4 });
  });

  it("fails with invalid_output after two invalid answers", async () => {
    const a = createFakeAdapter([
      { result: { summary: "no json" } },
      { result: { summary: "{}" } },
    ]);
    const r = await runStructured(a, task(), Schema);
    expect(r.value).toBeNull();
    expect(r.result).toMatchObject({ ok: false, failureReason: "invalid_output" });
  });

  it("does not retry an engine failure", async () => {
    const a = createFakeAdapter([{ result: { ok: false, failureReason: "budget" } }]);
    const r = await runStructured(a, task(), Schema);
    expect(r.result.failureReason).toBe("budget");
    expect(a.calls).toHaveLength(1);
  });
});

describe("extractJson", () => {
  it("accepts raw JSON, fenced JSON and JSON surrounded by prose", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('결과는 {"a":3} 입니다')).toEqual({ a: 3 });
    expect(() => extractJson("nothing")).toThrow(SyntaxError);
  });
});

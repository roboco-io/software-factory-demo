import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { claudeOptions, createClaudeAdapter, type QueryFn } from "../src/agents/claude";
import type { AgentTask } from "../src/agents/types";

const task = (readOnly: boolean): AgentTask => ({
  role: readOnly ? "review" : "implement",
  prompt: "do it",
  cwd: "/work",
  readOnly,
  budget: { maxTurns: 80, timeoutMs: 1_800_000, maxUsd: 5 },
});

function resultMessage(over: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "변경 요약",
    num_turns: 41,
    total_cost_usd: 1.82,
    errors: [],
    modelUsage: {
      "claude-sonnet-5-5": {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 1.5,
        contextWindow: 0,
        maxOutputTokens: 0,
      },
      "claude-haiku-5": {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.32,
        contextWindow: 0,
        maxOutputTokens: 0,
      },
    },
    ...over,
  } as unknown as SDKMessage;
}

function fakeQuery(messages: SDKMessage[], seen: Options[] = []): QueryFn {
  return ({ options }) => {
    if (options) seen.push(options);
    return (async function* () {
      yield { type: "system" } as unknown as SDKMessage;
      for (const m of messages) yield m;
    })();
  };
}

describe("claudeOptions", () => {
  it("uses read tools and dontAsk for read-only tasks", () => {
    const o = claudeOptions(task(true), "m", { PATH: "/bin" }, new AbortController());
    expect(o).toMatchObject({
      model: "m",
      cwd: "/work",
      maxTurns: 80,
      maxBudgetUsd: 5,
      permissionMode: "dontAsk",
      allowedTools: ["Read", "Glob", "Grep"],
      disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"],
      settingSources: ["project"],
    });
    expect(o.allowDangerouslySkipPermissions).toBeUndefined();
  });

  it("uses bypassPermissions with the explicit opt-in for write tasks", () => {
    const o = claudeOptions(task(false), "m", { PATH: "/bin" }, new AbortController());
    expect(o.permissionMode).toBe("bypassPermissions");
    expect(o.allowDangerouslySkipPermissions).toBe(true);
    expect(o.env).toEqual({ PATH: "/bin" });
  });
});

describe("createClaudeAdapter", () => {
  it("maps a success result, summing tokens across models", async () => {
    const seen: Options[] = [];
    const a = createClaudeAdapter({
      model: "claude-sonnet-5-5",
      env: {},
      query: fakeQuery([resultMessage()], seen),
    });
    const r = await a.run(task(false));
    expect(r).toEqual({
      ok: true,
      summary: "변경 요약",
      model: "claude-sonnet-5-5",
      turns: 41,
      costUsd: 1.82,
      usage: { inputTokens: 1100, outputTokens: 220 },
    });
    expect(seen[0]?.abortController).toBeInstanceOf(AbortController);
  });

  it.each([
    ["error_max_turns", "max_turns"],
    ["error_max_budget_usd", "budget"],
    ["error_during_execution", "engine_error"],
  ])("maps %s to %s", async (subtype, reason) => {
    const a = createClaudeAdapter({
      model: "m",
      env: {},
      query: fakeQuery([resultMessage({ subtype, errors: ["stopped"] })]),
    });
    expect(await a.run(task(false))).toMatchObject({
      ok: false,
      failureReason: reason,
      summary: "stopped",
    });
  });

  it("treats an is_error success and a missing result as engine_error", async () => {
    const isError = createClaudeAdapter({
      model: "m",
      env: {},
      query: fakeQuery([resultMessage({ is_error: true })]),
    });
    expect((await isError.run(task(false))).failureReason).toBe("engine_error");
    const none = createClaudeAdapter({ model: "m", env: {}, query: fakeQuery([]) });
    expect(await none.run(task(false))).toMatchObject({ ok: false, failureReason: "engine_error" });
  });

  it("reports timeout when the task signal aborted the stream", async () => {
    const controller = new AbortController();
    const query: QueryFn = () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => {
          controller.abort();
          return Promise.reject(new Error("aborted"));
        },
      }),
    });
    const a = createClaudeAdapter({ model: "m", env: {}, query });
    const r = await a.run({ ...task(false), signal: controller.signal });
    expect(r.failureReason).toBe("timeout");
  });
});
